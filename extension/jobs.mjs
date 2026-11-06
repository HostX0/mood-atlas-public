import {validateJob, safeFailure} from './protocol.mjs';

export function snapshot(job) {
  return {marker: job.marker, name: job.name, playlistId: job.playlistId, state: job.state,
    confirmed: job.confirmed, duplicates: job.duplicates || [], total: job.videoIds.length, error: job.error || null};
}
// Every mutation is checkpointed. An interrupted write is reconciled by reading YouTube before retrying.
export class JobEngine {
  constructor({read, write, youtube, batchSize = 1}) {
    Object.assign(this, {read, write, youtube, batchSize});
  }
  async start(input) {
    const spec = validateJob(input), previous = await this.read(spec.marker);
    if (previous && (previous.account !== spec.account || previous.name !== spec.name)) throw new Error('JOB_CONFLICT');
    const job = previous || {...spec, playlistId: null, confirmed: [], state: 'new', createAttempted: false};
    job.videoIds = [...new Set([...job.videoIds, ...spec.videoIds])];
    job.state = 'paused'; job.error = null;
    await this.write(job);
    return snapshot(job);
  }
  async adopt(input) {
    const spec = validateJob(input);
    if (typeof input.playlistId !== 'string' || !/^[A-Za-z0-9_-]{10,100}$/.test(input.playlistId)) throw new Error('INVALID_JOB');
    const previous = await this.read(spec.marker);
    if (previous && (previous.account !== spec.account || previous.name !== spec.name || (previous.playlistId && previous.playlistId !== input.playlistId))) throw new Error('JOB_CONFLICT');
    if ((await this.youtube.account()).fingerprint !== spec.account) throw new Error('ACCOUNT_CHANGED');
    const existing = await this.youtube.playlist(input.playlistId, spec.marker);
    const videoIds = [...new Set([...(previous?.videoIds || []), ...spec.videoIds])];
    const confirmed = videoIds.filter(id => existing.has(id));
    const duplicates = (previous?.duplicates || []).filter(id => !existing.has(id));
    const job = {...spec, videoIds, playlistId: input.playlistId, confirmed, duplicates, createAttempted: true,
      nextBatchSize: previous?.nextBatchSize || null,
      state: confirmed.length + duplicates.length === videoIds.length ? 'complete' : 'paused', error: null};
    await this.write(job);
    return snapshot(job);
  }
  async step(marker) {
    const job = await this.read(marker);
    if (!job) throw new Error('JOB_NOT_FOUND');
    try {
      const account = await this.youtube.account();
      if (account.fingerprint !== job.account) throw new Error('ACCOUNT_CHANGED');
      if (!job.playlistId) {
        const recovered = await this.youtube.find(job.name, marker);
        if (recovered) job.playlistId = recovered;
        else {
          if (job.createAttempted) throw new Error('CREATE_UNCERTAIN');
          if ((await this.youtube.account()).fingerprint !== job.account) throw new Error('ACCOUNT_CHANGED');
          job.createAttempted = true; job.state = 'creating'; await this.write(job);
          job.playlistId = await this.youtube.create(job.name, marker);
        }
        job.state = 'copying'; await this.write(job);
      }
      const existing = await this.youtube.playlist(job.playlistId, marker);
      job.confirmed = job.videoIds.filter(id => existing.has(id));
      job.duplicates = (job.duplicates || []).filter(id => !existing.has(id));
      const duplicates = new Set(job.duplicates);
      const next = job.videoIds.filter(id => !existing.has(id) && !duplicates.has(id)).slice(0, job.nextBatchSize || this.batchSize);
      if (!next.length) { job.state = 'complete'; job.error = null; await this.write(job); return snapshot(job); }
      // Confirm identity again immediately before the write, including after playlist pagination.
      if ((await this.youtube.account()).fingerprint !== job.account) throw new Error('ACCOUNT_CHANGED');
      job.state = 'copying'; job.inflight = next.length === 1 ? next[0] : next; job.error = null;
      await this.write(job);
      try {
        await this.youtube.add(job.playlistId, job.inflight);
        const final = await this.youtube.playlist(job.playlistId, marker);
        job.confirmed = job.videoIds.filter(id => final.has(id));
        job.duplicates = job.duplicates.filter(id => !final.has(id));
        if (next.some(id => !final.has(id))) throw new Error('ADD_UNCERTAIN');
        job.nextBatchSize = null;
      } catch (error) {
        if (error.message === 'DUPLICATE_TRACK') {
          if (next.length > 1) job.nextBatchSize = Math.ceil(next.length / 2);
          else {
            // YouTube recognizes a duplicate, but the exact selected video is absent.
            const updated = await this.youtube.playlist(job.playlistId, marker);
            job.confirmed = job.videoIds.filter(id => updated.has(id));
            job.duplicates = job.duplicates.filter(id => !updated.has(id));
            if (!updated.has(next[0])) job.duplicates.push(next[0]);
            job.nextBatchSize = null;
          }
        } else {
          if (next.length > 1 && ['ADD_UNCERTAIN', 'YOUTUBE_REJECTED'].includes(error.message)) {
            job.nextBatchSize = Math.ceil(next.length / 2);
            throw new Error('ADD_UNCERTAIN');
          }
          throw error;
        }
      }
      job.inflight = null;
      job.state = job.confirmed.length + job.duplicates.length === job.videoIds.length ? 'complete' : 'copying';
      await this.write(job);
      return snapshot(job);
    } catch (error) {
      job.state = 'paused'; job.error = safeFailure(error).code; await this.write(job);
      throw error;
    }
  }
}
