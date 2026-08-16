import { useRef, type KeyboardEvent } from "react";

export type CodesWorkspaceTab = "evidence" | "codebook" | "export";

type CodesWorkspaceTabsProps = {
  activeTab: CodesWorkspaceTab;
  onTabChange: (tab: CodesWorkspaceTab) => void;
};

const tabs: Array<{ id: CodesWorkspaceTab; label: string }> = [
  { id: "evidence", label: "Transcript Coding" },
  { id: "codebook", label: "Codebook" },
  { id: "export", label: "Export" }
];

export function CodesWorkspaceTabs({ activeTab, onTabChange }: CodesWorkspaceTabsProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onTabChange(tabs[nextIndex].id);
    buttonRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="segmented-control compact-segmented-control codes-workspace-tabs" role="tablist" aria-label="Codes workspace">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          ref={(element) => { buttonRefs.current[index] = element; }}
          id={`codes-tab-${tab.id}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`codes-panel-${tab.id}`}
          tabIndex={activeTab === tab.id ? 0 : -1}
          className={activeTab === tab.id ? "segment active" : "segment"}
          onClick={() => onTabChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
