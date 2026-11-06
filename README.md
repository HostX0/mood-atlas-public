# Mood Atlas

Move songs from Excel and CSV into YouTube Music playlists. Import several sheets, find matching recordings, review exceptions, and transfer the ready tracks in one batch.

[Open Mood Atlas](https://mood-atlas-public.vercel.app) · [Download the Excel template](https://mood-atlas-public.vercel.app/assets/Mood-Atlas-Template.xlsx) · [Get the Chrome extension](https://github.com/HostX0/mood-atlas-public/releases/latest)

## Quick start

1. **Import your music.** Open Mood Atlas and choose **Upload spreadsheets**. Drop one or more CSV or XLSX files into the import dialog, or select **Try the sample**. Use `Title` and `Artist` headers for the simplest import. Each CSV file or single-tab workbook becomes a playlist named after the file. In a workbook with multiple tabs, each tab becomes a playlist with its own name.
2. **Find matches.** Open a playlist and choose **Match playlist**, or choose **Match and transfer all** and select **Search and match only** to prepare the whole library. Automatic matching approves suitable recordings. Check the review queue for different artists, different versions, and missing tracks.
3. **Transfer to YouTube Music.** Install the extension below, connect your account, and choose **Transfer ready tracks** for one playlist or **Match and transfer all** for a batch. Check the account shown before confirming. New playlists are private. Keep Mood Atlas and YouTube Music open during transfer.

Mood Atlas opens without an account. Sign in to YouTube Music in Chrome when you want to transfer.

## Install Mood Atlas Connect

1. Download [Mood Atlas Connect](https://github.com/HostX0/mood-atlas-public/releases/latest) and unzip it into a folder you can keep.
2. In desktop Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Select **Load unpacked**, then choose the extracted `Mood-Atlas-Connect` folder containing `manifest.json`.
4. Open [YouTube Music](https://music.youtube.com/) in the same Chrome profile and sign in there. Refresh Mood Atlas and choose **Connect YouTube Music**.
5. To update, replace the files in the same folder, select **Reload** on the extension card, then refresh Mood Atlas and reconnect.

The extension is distributed as a ZIP for manual installation. The workspace also offers a download in its connection dialog.

## Privacy and progress

Spreadsheet files, choices, and progress are stored in your browser. Searches send song titles and artist names to the Mood Atlas server, which queries YouTube Music. The extension uses the signed-in YouTube Music tab for playlist writes. Google cookies and authentication headers stay inside that tab.

Temporary errors retry from the last saved step. Reopen Mood Atlas to resume an interrupted task. For an account or playlist issue, follow the action shown in the workspace. YouTube Music may throttle or reject requests. Export a backup from **Library options** before clearing browser data or moving to another browser.

## Run locally

Requires Python 3.12 or later. Run these commands from the project directory.

```sh
python -m venv .venv
# Activate the virtual environment for your platform first.
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765`. For local transfers, load the project's `extension` folder in Chrome. The extension accepts the hosted Mood Atlas origin and this exact local origin. When hosting your own build, update the origin consistently in the extension manifest, bridge, protocol, and popup.

### Run the tests

```sh
python -m pip install pytest httpx
python -m pytest -q
node --test tests/*.mjs
```

Public search has per-instance concurrency and request limits. Transfer jobs verify the account, playlist marker, and recording membership before writing. The SheetJS parser and bundled fonts include their respective license notices.
