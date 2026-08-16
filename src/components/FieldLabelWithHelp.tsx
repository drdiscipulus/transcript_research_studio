import {
  type CSSProperties,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react";

type FieldLabelWithHelpProps = {
  label: string;
  helpText: string;
  labelClassName?: string;
  hideLabel?: boolean;
  htmlFor?: string;
};

type TooltipStyle = CSSProperties & {
  "--field-tooltip-left": string;
  "--field-tooltip-top": string;
  "--field-tooltip-width": string;
};

const TOOLTIP_MAX_WIDTH = 288;
const TOOLTIP_MIN_WIDTH = 180;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_GAP = 8;

function clamp(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

export function FieldLabelWithHelp({
  label,
  helpText,
  labelClassName = "field-label",
  hideLabel = false,
  htmlFor
}: FieldLabelWithHelpProps) {
  const tooltipId = useId();
  const helpRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<TooltipStyle | null>(null);

  const updateTooltipPosition = useCallback(() => {
    const helpElement = helpRef.current;
    const tooltipElement = tooltipRef.current;
    if (!helpElement || !tooltipElement) {
      return;
    }

    const anchorRect = helpElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const tooltipWidth = clamp(
      Math.min(TOOLTIP_MAX_WIDTH, viewportWidth - TOOLTIP_MARGIN * 2),
      Math.min(TOOLTIP_MIN_WIDTH, viewportWidth - TOOLTIP_MARGIN * 2),
      TOOLTIP_MAX_WIDTH
    );

    tooltipElement.style.setProperty("--field-tooltip-width", `${tooltipWidth}px`);
    const tooltipHeight = tooltipElement.offsetHeight;
    const anchorCenter = anchorRect.left + anchorRect.width / 2;
    const left = clamp(
      anchorCenter - tooltipWidth / 2,
      TOOLTIP_MARGIN,
      viewportWidth - TOOLTIP_MARGIN - tooltipWidth
    );
    const topAbove = anchorRect.top - TOOLTIP_GAP - tooltipHeight;
    const topBelow = anchorRect.bottom + TOOLTIP_GAP;
    const preferredTop = topAbove >= TOOLTIP_MARGIN ? topAbove : topBelow;
    const top = clamp(
      preferredTop,
      TOOLTIP_MARGIN,
      viewportHeight - TOOLTIP_MARGIN - tooltipHeight
    );

    setTooltipStyle({
      "--field-tooltip-left": `${left}px`,
      "--field-tooltip-top": `${top}px`,
      "--field-tooltip-width": `${tooltipWidth}px`
    });
  }, []);

  useLayoutEffect(() => {
    if (!isTooltipVisible) {
      setTooltipStyle(null);
      return;
    }

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [isTooltipVisible, updateTooltipPosition]);

  const hideTooltipIfUnfocused = useCallback(() => {
    if (helpRef.current !== document.activeElement) {
      setIsTooltipVisible(false);
    }
  }, []);

  return (
    <span className={`${labelClassName} field-label-with-help`}>
      {hideLabel ? null : htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <button
        type="button"
        ref={helpRef}
        className="field-help"
        aria-label={`Help: ${label}`}
        aria-describedby={tooltipId}
        onBlur={hideTooltipIfUnfocused}
        onFocus={() => setIsTooltipVisible(true)}
        onMouseEnter={() => setIsTooltipVisible(true)}
        onMouseLeave={hideTooltipIfUnfocused}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setIsTooltipVisible(false);
        }}
      >
        <span className="field-help-icon" aria-hidden="true">
          ?
        </span>
        <span
          ref={tooltipRef}
          id={tooltipId}
          className={`field-help-tooltip ${isTooltipVisible && tooltipStyle ? "visible" : ""}`}
          role="tooltip"
          style={tooltipStyle ?? undefined}
        >
          {helpText}
        </span>
      </button>
    </span>
  );
}
