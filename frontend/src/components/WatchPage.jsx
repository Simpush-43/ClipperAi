import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Clapperboard, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { api } from "../lib/api.js";

export function WatchPage({ shareId }) {
  const videoRef = useRef(null);
  const [video, setVideo] = useState(null);
  const [error, setError] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [usingFallback, setUsingFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVideo(null);
    setError("");
    api(`/api/watch/${encodeURIComponent(shareId)}`)
      .then((result) => { if (!cancelled) setVideo(result); })
      .catch((issue) => { if (!cancelled) setError(issue.message); });
    return () => { cancelled = true; };
  }, [shareId, retryKey]);

  useEffect(() => {
    if (!video || usingFallback || !video.hlsUrl || !videoRef.current) return undefined;
    const player = videoRef.current;
    let hls;
    let disposed = false;

    if (player.canPlayType("application/vnd.apple.mpegurl")) {
      player.src = video.hlsUrl;
      return () => { player.removeAttribute("src"); player.load(); };
    }

    import("hls.js").then(({ default: Hls }) => {
      if (disposed) return;
      if (!Hls.isSupported()) {
        if (video.mp4Url) setUsingFallback(true);
        else setPlaybackError("This browser cannot play the available streaming format.");
        return;
      }
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(video.hlsUrl);
      hls.attachMedia(player);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (video.mp4Url) setUsingFallback(true);
        else setPlaybackError("Playback could not start. Try again.");
      });
    }).catch(() => {
      if (video.mp4Url) setUsingFallback(true);
      else setPlaybackError("Streaming support could not be loaded.");
    });

    return () => {
      disposed = true;
      hls?.destroy();
    };
  }, [video, usingFallback]);

  const source = usingFallback || !video?.hlsUrl ? video?.mp4Url : undefined;
  return <main className="watch-page">
    <header className="watch-header"><a href="/" className="brand"><span className="brand-symbol"><Clapperboard size={17} /></span> clipper<span className="brand-dot">.</span></a><span><ShieldAlert size={13} /> SHARED MEDIA</span></header>
    <section className="watch-content">
      {error ? <div className="watch-message"><ShieldAlert size={24} /><h1>Video unavailable</h1><p>{error}</p><button className="button button-outline" onClick={() => setRetryKey((key) => key + 1)}><RefreshCw size={14} /> Try again</button></div>
        : !video ? <div className="watch-message"><LoaderCircle size={20} className="spin" /><p>Loading shared video…</p></div>
          : <><div className="watch-kicker">CLIPPER · SHARED VIDEO</div><h1>{video.title}</h1>{video.metadata && <p className="watch-meta">{Math.round(video.metadata.duration)} sec <span>·</span> {video.metadata.width} × {video.metadata.height}</p>}
            <div className="watch-player">
              <video ref={videoRef} src={source} poster={video.thumbnailUrl || undefined} controls playsInline preload="metadata" onError={() => {
                if (video.hlsUrl && video.mp4Url && !usingFallback) setUsingFallback(true);
                else setPlaybackError("Playback failed. Try again or use a different browser.");
              }} />
              {playbackError && <div className="watch-playback-error"><p>{playbackError}</p><button className="button button-outline" onClick={() => { setPlaybackError(""); setUsingFallback(Boolean(video.mp4Url)); }}><RefreshCw size={14} /> Retry</button></div>}
            </div>
            <p className="watch-disclaimer">Anyone with this link may be able to watch this video. Shared links are not DRM-protected.</p>
          </>}
      <a className="watch-back" href="/"><ArrowLeft size={14} /> Clipper Studio</a>
    </section>
  </main>;
}
