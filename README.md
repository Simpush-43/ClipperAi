# ClipperAi

## Accounts and authentication

Email/password sign-up creates a signed-in account immediately; verification mail is not required. Password reset remains an explicit email flow and requires SMTP settings. Google sign-in requires a Google OAuth web client. Set `GOOGLE_REDIRECT_URI` to the exact deployed callback URL (`https://YOUR_HOST/api/auth/google/callback`) and register that same URL in the Google Cloud Console. Set `APP_BASE_URL` to the public HTTPS origin. Never auto-link a Google identity to an existing password account by matching email; link it after signing in to that account.

Account sessions are held in process memory and signed with `DASHBOARD_SESSION_SECRET`; restarting the service invalidates existing sessions. Use a unique random secret of at least 32 characters. Do not set `DASHBOARD_PASSWORD` unless the legacy dashboard login is deliberately needed.

## Video uploads and Cloudflare R2

Create a private R2 bucket and a least-privilege API token scoped to that bucket. Keep public bucket access disabled. The backend issues short-lived presigned multipart-part URLs; the browser uploads video parts directly to R2, and the backend verifies part ETags and sizes before completing the object. The default `VIDEO_UPLOAD_PART_BYTES` is 16 MiB (minimum 5 MiB, maximum 5 GiB). The default maximum source is 2 GiB (`VIDEO_MAX_BYTES`) and the maximum duration is two hours (`VIDEO_MAX_DURATION_SECONDS`). Adjust these limits to fit the service's available disk, memory, and processing time.

Configure the bucket's CORS policy for the exact frontend origin(s) (for example, the deployed HTTPS origin and `http://127.0.0.1:5173` during local development). Allow method `PUT`, allow request headers required by browser uploads (using `*` is the simplest compatible option), and expose response header `ETag`. Do not use `*` as an allowed origin in production. The ETag is required to resume and securely complete multipart uploads. Abandoned uploads become eligible for cleanup after 24 hours; the worker runs that cleanup every six hours.

R2 objects remain private. Video assets are streamed by the application after checking either account ownership or the current share-link settings on each request. Share links are bearer links: anyone who has one can watch while sharing is enabled and the link is unexpired. Revocation blocks new asset requests; an already-open media stream may finish. Responses are sent with no-store cache headers.

## Render deployment

The repository is split into `frontend/` and `backend/`. Deploy it as one Render web service from the repository root; `render.yaml` builds the frontend into `frontend/dist` and the backend serves it alongside the API. The service also runs the MongoDB-backed video processing worker, so the instance needs enough CPU and temporary disk for FFmpeg. Do not configure multiple independent worker-only services with the same settings unless you intentionally want more processing capacity.

In Render, create a Blueprint from this repository and set the prompted environment variables. `DASHBOARD_SESSION_SECRET` must be at least 32 characters. MongoDB, Cloudflare R2, Groq, and Gemini credentials are required for the app's storage and clip-generation workflows. Google OAuth credentials are needed only for Google sign-in; SMTP credentials are only needed for password-reset email. Instagram credentials are only needed for Instagram publishing. Set `APP_BASE_URL` and `GOOGLE_REDIRECT_URI` to the production HTTPS host and its OAuth callback.

The Blueprint installs Deno and configures yt-dlp to use it. If YouTube still requires sign-in, add a YouTube cookies export as a Render Secret File and set `YTDLP_COOKIES_FILE` to that file's path (for example, `/etc/secrets/youtube-cookies.txt`). Never commit or paste the cookies file; use an account you control and replace the export when it expires.
