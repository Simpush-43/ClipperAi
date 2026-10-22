import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpFromLine, Copy, Film, LoaderCircle, RefreshCw, Share2, Trash2, X } from "lucide-react";
import { api } from "../lib/api.js";

const statusLabels = {
  uploading: "Uploading",
  queued: "Queued",
  processing: "Processing",
  ready: "Ready",
  partially_ready: "Partially ready",
  failed: "Failed",
};

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function asLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function uploadFile(file, uploadUrl, onProgress) {
  const request = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    request.open("PUT", uploadUrl);
    request.withCredentials = false;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        const etag = request.getResponseHeader("ETag");
        if (etag) resolve(etag);
        else reject(new Error("Storage did not return the part ETag. Check the R2 CORS expose-headers setting."));
      }
      else reject(new Error(`Cloud upload failed (${request.status}).`));
    });
    request.addEventListener("error", () => reject(new Error("Cloud upload could not connect. Check the storage CORS configuration and retry.")));
    request.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")));
    request.send(file);
  });
  return { request, promise };
}

function VideoItem({ video, progress, onRefresh, onNotify, onCancel, onResume, uploadBusy }) {
  const [title, setTitle] = useState(video.title);
  const [expiresAt, setExpiresAt] = useState(asLocalDateTime(video.shareExpiresAt));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(video.title);
    setExpiresAt(asLocalDateTime(video.shareExpiresAt));
  }, [video.title, video.shareExpiresAt]);

  async function saveTitle(event) {
    event.preventDefault();
    const normalized = title.trim();
    if (!normalized || normalized === video.title) return;
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: normalized }),
      });
      onNotify("Title updated");
      onRefresh();
    } catch (error) {
      onNotify(error.message);
      setTitle(video.title);
    } finally {
      setBusy(false);
    }
  }

  async function setSharing(shareMode) {
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareMode }),
      });
      onRefresh();
      onNotify(shareMode === "private" ? "Sharing revoked" : "Sharing link updated");
    } catch (error) {
      onNotify(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveExpiration() {
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }),
      });
      onRefresh();
      onNotify(expiresAt ? "Share-link expiration saved" : "Share link will not expire");
    } catch (error) {
      onNotify(error.message);
      setExpiresAt(asLocalDateTime(video.shareExpiresAt));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}/retry`, { method: "POST" });
      onRefresh();
    } catch (error) {
      onNotify(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Permanently delete “${video.title}” and its uploaded media?`)) return;
    setBusy(true);
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      onRefresh();
      onNotify("Video and stored renditions deleted");
    } catch (error) {
      onNotify(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyShareLink() {
    const url = `${window.location.origin}/watch/${video.shareId}`;
    try {
      await navigator.clipboard.writeText(url);
      onNotify("Share link copied");
    } catch {
      onNotify("Could not copy the share link. Copy it from the address bar: " + url);
    }
  }

  const status = video.status;
  const isActive = ["uploading", "queued", "processing"].includes(status);
  return <article className="video-item">
    <div className="video-thumb">
      {video.thumbnailUrl && <img src={video.thumbnailUrl} alt="" />}
      {!video.thumbnailUrl && <Film size={22} />}
      {video.mp4Url && <video className="video-preview" src={video.mp4Url} controls playsInline preload="metadata" poster={video.thumbnailUrl || undefined} />}
    </div>
    <div className="video-details">
      <form className="video-title-form" onSubmit={saveTitle}>
        <input aria-label="Video title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={busy} />
        <button type="submit" disabled={busy || !title.trim() || title.trim() === video.title}>Save</button>
      </form>
      <div className="video-file-meta"><span>{video.originalName}</span><span>{formatBytes(video.size)}</span>{video.metadata && <span>{Math.round(video.metadata.duration)} sec · {video.metadata.width}×{video.metadata.height}</span>}</div>
      <div className={`video-state video-state-${status}`}><i />{statusLabels[status] || status}{status === "uploading" && progress !== undefined && <span>{progress}% uploaded</span>}{isActive && <LoaderCircle size={13} className="spin" />}</div>
      {video.error && <p className="video-error">{video.error}</p>}
      {status === "uploading" && <div className="upload-progress"><span style={{ width: `${progress || 0}%` }} /></div>}
      {["ready", "partially_ready"].includes(status) && <div className="video-sharing">
        <label>SHARING
          <select value={video.shareMode} onChange={(event) => setSharing(event.target.value)} disabled={busy}>
            <option value="private">Private</option>
            <option value="unlisted">Anyone with link</option>
            <option value="public">Public link</option>
          </select>
        </label>
        {video.shareMode !== "private" && video.shareId && <button className="video-action" onClick={copyShareLink} title="Copy share link"><Copy size={14} /> Copy link</button>}
        {video.shareMode !== "private" && <label>EXPIRES
          <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} onBlur={saveExpiration} disabled={busy} />
        </label>}
        {video.shareMode !== "private" && <span className="share-warning"><Share2 size={12} /> Anyone with this link can watch.</span>}
      </div>}
      <div className="video-actions">
        {status === "failed" && <button className="video-action" onClick={retry} disabled={busy}><RefreshCw size={13} /> Retry processing</button>}
        {status === "uploading" && <button className="video-action" onClick={() => onResume(video.id)} disabled={uploadBusy}><ArrowUpFromLine size={13} /> Resume upload</button>}
        {status === "uploading" && <button className="video-action video-cancel" onClick={() => onCancel(video.id)}><X size={13} /> Cancel upload</button>}
        {["ready", "partially_ready"].includes(status) && <a className="video-action" href={video.shareMode === "private" ? video.mp4Url : `/watch/${video.shareId}`} target="_blank" rel="noreferrer"><Share2 size={13} /> Open watch page</a>}
        <button className="video-action video-delete" onClick={remove} disabled={busy}><Trash2 size={13} /> Delete</button>
      </div>
    </div>
  </article>;
}

export function VideoLibrary({ notify }) {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({});
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const resumeTarget = useRef(null);
  const activeRequest = useRef(null);
  const cancelled = useRef(new Set());

  const refresh = useCallback(async () => {
    try {
      const result = await api("/api/videos");
      setVideos(result.videos);
      setError("");
    } catch (issue) {
      setError(issue.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!videos.some((video) => ["queued", "processing"].includes(video.status))) return undefined;
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh, videos]);

  async function uploadFiles(fileList, requestedResumeId = null) {
    const files = [...fileList];
    if (!files.length) return;
    if (requestedResumeId && files.length !== 1) {
      setError("Choose one file to resume this upload.");
      return;
    }
    setUploading(true);
    setError("");
    for (const file of files) {
      let videoId;
      try {
        const existing = requestedResumeId
          ? videos.find((item) => item.id === requestedResumeId && item.status === "uploading")
          : videos.find((item) => item.status === "uploading" && item.originalName === file.name && item.size === file.size);
        if (requestedResumeId && (!existing || existing.originalName !== file.name || existing.size !== file.size)) {
          throw new Error("Choose the same file that was selected for this upload to resume it.");
        }
        if (existing) {
          videoId = existing.id;
        } else {
          const initiated = await api("/api/videos/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
          });
          videoId = initiated.video.id;
          setVideos((items) => [initiated.video, ...items.filter((item) => item.id !== videoId)]);
        }
        const status = await api(`/api/videos/${videoId}/upload-parts/status`);
        if (status.completed) {
          await api(`/api/videos/${videoId}/complete`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [] }),
          });
          notify(`${file.name} upload recovered; processing has started`);
          continue;
        }
        const { partSize } = status.video;
        const totalParts = Math.ceil(file.size / partSize);
        const uploadedParts = new Map(status.parts.map((part) => [part.partNumber, part]));
        const completed = [];
        let uploadedBytes = 0;
        for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
          const expectedSize = partNumber === totalParts ? file.size - (partNumber - 1) * partSize : partSize;
          const part = uploadedParts.get(partNumber);
          if (part && part.size === expectedSize && part.etag) {
            completed.push({ partNumber, etag: part.etag });
            uploadedBytes += expectedSize;
          }
        }
        const completedNumbers = new Set(completed.map((part) => part.partNumber));
        setProgress((items) => ({ ...items, [videoId]: Math.floor(uploadedBytes / file.size * 100) }));
        const missing = Array.from({ length: totalParts }, (_, index) => index + 1)
          .filter((partNumber) => !completedNumbers.has(partNumber));
        for (let offset = 0; offset < missing.length; offset += 8) {
          if (cancelled.current.has(videoId)) throw new DOMException("Upload cancelled", "AbortError");
          const batch = missing.slice(offset, offset + 8);
          const signed = await api(`/api/videos/${videoId}/upload-parts/urls`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ partNumbers: batch }),
          });
          const signedUrls = new Map(signed.urls.map((item) => [item.partNumber, item.url]));
          for (const partNumber of batch) {
            if (cancelled.current.has(videoId)) throw new DOMException("Upload cancelled", "AbortError");
            const start = (partNumber - 1) * partSize;
            const end = Math.min(start + partSize, file.size);
            const transfer = uploadFile(file.slice(start, end), signedUrls.get(partNumber), (loaded) => {
              setProgress((items) => ({ ...items, [videoId]: Math.floor(Math.min(file.size, uploadedBytes + loaded) / file.size * 100) }));
            });
            activeRequest.current = { videoId, request: transfer.request };
            const etag = await transfer.promise;
            activeRequest.current = null;
            completed.push({ partNumber, etag });
            uploadedBytes += end - start;
            setProgress((items) => ({ ...items, [videoId]: Math.floor(uploadedBytes / file.size * 100) }));
          }
        }
        if (cancelled.current.has(videoId)) throw new DOMException("Upload cancelled", "AbortError");
        await api(`/api/videos/${videoId}/complete`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: completed }),
        });
        notify(`${file.name} uploaded; processing has started`);
      } catch (issue) {
        if (issue.name === "AbortError" || (videoId && cancelled.current.has(videoId))) {
          if (videoId) await api(`/api/videos/${videoId}`, { method: "DELETE" }).catch(() => {});
        } else {
          setError(issue.message);
        }
      } finally {
        if (activeRequest.current?.videoId === videoId) activeRequest.current = null;
        if (videoId) {
          cancelled.current.delete(videoId);
          setProgress((items) => {
            const { [videoId]: ignored, ...remaining } = items;
            return remaining;
          });
        }
      }
    }
    setUploading(false);
    await refresh();
  }

  function cancelUpload(videoId) {
    cancelled.current.add(videoId);
    if (activeRequest.current?.videoId === videoId) {
      activeRequest.current.request.abort();
      return;
    }
    void api(`/api/videos/${videoId}`, { method: "DELETE" })
      .then(() => setVideos((items) => items.filter((item) => item.id !== videoId)))
      .catch((issue) => setError(issue.message));
  }

  function resumeUpload(videoId) {
    resumeTarget.current = videoId;
    inputRef.current?.click();
  }

  return <section className="video-library">
    <div className="section-heading"><div><div className="date-kicker">UPLOAD AND SHARE</div><h2>My videos <span className="clip-count-badge">{videos.length}</span></h2></div><button className="refresh-button" onClick={refresh} disabled={loading}>{loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Refresh</button></div>
    <div className={`video-dropzone ${dragging ? "video-dropzone-active" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
      <div className="video-drop-icon"><ArrowUpFromLine size={20} /></div><h3>Drop videos to upload</h3><p>MP4, MOV, WebM, MKV or MPEG · Up to {Math.floor((Number(import.meta.env.VITE_VIDEO_MAX_MB) || 2048))} MB per file</p>
      <button className="button button-outline" onClick={() => inputRef.current?.click()} disabled={uploading}>{uploading ? <LoaderCircle size={15} className="spin" /> : "Choose videos"}<ArrowUpFromLine size={14} /></button>
      <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/mpeg,.mkv,.mpeg,.mpg" multiple hidden onChange={(event) => { void uploadFiles(event.target.files, resumeTarget.current); resumeTarget.current = null; event.target.value = ""; }} />
    </div>
    <p className="video-privacy-note">New videos are private by default. Choose “Anyone with link” to share an unlisted bearer link; anyone who has it can watch.</p>
    {error && <p className="video-error">{error}</p>}
    {loading && !videos.length ? <div className="video-empty"><LoaderCircle className="spin" size={19} /> Loading your videos</div> : videos.length ? <div className="video-list">{videos.map((video) => <VideoItem key={video.id} video={video} progress={progress[video.id]} onRefresh={refresh} onNotify={notify} onCancel={cancelUpload} onResume={resumeUpload} uploadBusy={uploading} />)}</div> : <div className="video-empty"><Film size={21} /><span>Your uploaded videos will appear here.</span></div>}
  </section>;
}
