"use client";

import dynamic from "next/dynamic";

const XtermTerminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

export default function TerminalPage() {
  return (
    <div className="h-screen p-4 bg-gray-800">
      <XtermTerminal />
    </div>
  );
}
