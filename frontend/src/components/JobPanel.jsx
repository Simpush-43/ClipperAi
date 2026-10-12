import { Check, CircleAlert, LoaderCircle } from "lucide-react";

const stages = [
  ["resolving", "Reading video"],
  ["downloading", "Downloading"],
  ["transcribing", "Transcribing"],
  ["selecting", "Finding moments"],
  ["rendering", "Rendering clips"],
  ["uploading", "Saving to cloud"],
  ["complete", "Ready"],
];

export function JobPanel({ job }) {
  const current = stages.findIndex(([key]) => key === job.stage);
  const failed = job.status === "failed";
  const complete = job.status === "complete";
  return <section className="job-panel" aria-live="polite">
    <div className={`job-panel-top ${failed ? "job-failed" : complete ? "job-complete" : ""}`}><div className="job-running-icon">{failed ? <CircleAlert size={17} /> : complete ? <Check size={17} /> : <LoaderCircle size={17} className="spin" />}</div><div className="job-message"><strong>{failed ? "Processing stopped" : job.message}</strong><span>{failed ? job.message : complete ? `${job.clipCount || 0} clips saved · Run ${job.id.slice(0, 8)}` : `${job.status === "queued" ? "Queued" : "In progress"} · Run ${job.id.slice(0, 8)}`}</span></div><span className="job-current-label">{failed ? "FAILED" : complete ? "READY" : job.stage.replaceAll("_", " ").toUpperCase()}</span></div>
    <div className="stage-track">{stages.slice(0, 6).map(([key, label], index) => {
      const done = complete || (!failed && current > index);
      const active = !failed && !complete && index === current;
      const failedStage = failed && index === current;
      return <div className={`stage-item ${done ? "stage-done" : ""} ${active ? "stage-current" : ""} ${failedStage ? "stage-error" : ""}`} key={key}><span className="stage-dot">{done ? <Check size={11} /> : failedStage ? <CircleAlert size={11} /> : null}</span><span>{label}</span></div>;
    })}</div>
  </section>;
}
