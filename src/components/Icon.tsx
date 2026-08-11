import type { SVGProps } from "react";

type Name = "back" | "folder" | "new" | "play" | "pause" | "rewind" | "forward" | "pen" | "undo" | "clear" | "panel" | "mic" | "export" | "home" | "check";

const paths: Record<Name, string> = {
  back: "M15 18l-6-6 6-6",
  folder: "M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z",
  new: "M12 5v14M5 12h14",
  play: "M8 5v14l11-7z",
  pause: "M9 5v14M15 5v14",
  rewind: "M11 6l-6 6 6 6M19 6l-6 6 6 6",
  forward: "M5 6l6 6-6 6M13 6l6 6-6 6",
  pen: "M4 20l4-1 11-11-3-3L5 16l-1 4zM14 7l3 3",
  undo: "M9 8l-5 4 5 4M5 12h8a6 6 0 0 1 6 6",
  clear: "M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M6 7l1 14h10l1-14",
  panel: "M4 5h16v14H4zM15 5v14",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
  export: "M12 16V4M8 8l4-4 4 4M5 14v6h14v-6",
  home: "M3 11l9-8 9 8M5 10v11h14V10M9 21v-7h6v7",
  check: "M5 13l4 4L19 7",
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: Name }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
