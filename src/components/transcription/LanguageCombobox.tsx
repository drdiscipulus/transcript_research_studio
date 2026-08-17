import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";

import type { TranscriptionLanguageOption } from "../../lib/api";
import { isTranscriptionLanguageAvailable } from "../../lib/workflowUtils";

type LanguageComboboxProps = {
  id: string;
  value: string;
  options: TranscriptionLanguageOption[];
  modelName: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

function firstAvailableIndex(options: TranscriptionLanguageOption[], modelName: string): number {
  return options.findIndex((option) => isTranscriptionLanguageAvailable(option, modelName));
}

function nextAvailableIndex(
  options: TranscriptionLanguageOption[],
  modelName: string,
  currentIndex: number,
  direction: 1 | -1
): number {
  if (!options.length) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const candidate = (currentIndex + direction * offset + options.length) % options.length;
    if (isTranscriptionLanguageAvailable(options[candidate], modelName)) return candidate;
  }
  return -1;
}

export function LanguageCombobox({
  id,
  value,
  options,
  modelName,
  disabled = false,
  onChange
}: LanguageComboboxProps) {
  const searchId = useId();
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? (value === "auto" ? "Auto-Detect" : value);
  const matchingOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options
      .filter((option) => (
        option.label.toLocaleLowerCase().includes(normalizedQuery)
        || option.value.toLocaleLowerCase().includes(normalizedQuery)
      ))
      .sort((left, right) => {
        const leftExact = left.value.toLocaleLowerCase() === normalizedQuery;
        const rightExact = right.value.toLocaleLowerCase() === normalizedQuery;
        return Number(rightExact) - Number(leftExact);
      });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const current = matchingOptions[activeIndex];
    if (current && isTranscriptionLanguageAvailable(current, modelName)) return;
    setActiveIndex(firstAvailableIndex(matchingOptions, modelName));
  }, [activeIndex, matchingOptions, modelName, open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const activeOption = matchingOptions[activeIndex];
    if (!activeOption) return;
    optionRefs.current.get(activeOption.value)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, matchingOptions, open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setQuery("");
  }, [disabled]);

  function openOptions() {
    if (disabled || !options.length) return;
    setQuery("");
    setOpen(true);
    const selectedIndex = options.findIndex((option) => (
      option.value === value && isTranscriptionLanguageAvailable(option, modelName)
    ));
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstAvailableIndex(options, modelName));
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  function closeOptions({ restoreFocus = false } = {}) {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function selectOption(option: TranscriptionLanguageOption) {
    if (!isTranscriptionLanguageAvailable(option, modelName)) return;
    onChange(option.value);
    closeOptions({ restoreFocus: true });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const startIndex = activeIndex >= 0
        ? activeIndex
        : direction === 1 ? -1 : 0;
      setActiveIndex(nextAvailableIndex(matchingOptions, modelName, startIndex, direction));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstAvailableIndex(matchingOptions, modelName));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const reversedIndex = firstAvailableIndex([...matchingOptions].reverse(), modelName);
      setActiveIndex(reversedIndex < 0 ? -1 : matchingOptions.length - reversedIndex - 1);
      return;
    }
    if (event.key === "Enter" && matchingOptions[activeIndex]) {
      event.preventDefault();
      selectOption(matchingOptions[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeOptions({ restoreFocus: true });
    }
  }

  return (
    <div
      className="language-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeOptions();
      }}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="text-input language-combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || !options.length}
        onClick={() => open ? closeOptions() : openOptions()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          openOptions();
        }}
      >
        <span>{selectedLabel}</span>
        <span className="language-combobox-caret" aria-hidden="true" />
      </button>

      {open ? (
        <div className="language-combobox-popup">
          <label className="language-combobox-search-label" htmlFor={searchId}>Search languages</label>
          <input
            ref={searchRef}
            id={searchId}
            className="text-input language-combobox-search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${matchingOptions[activeIndex]?.value}` : undefined}
            value={query}
            placeholder="Type a language or code"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <div id={listboxId} className="language-combobox-options" role="listbox" aria-label="Languages">
            {matchingOptions.map((option, index) => {
              const available = isTranscriptionLanguageAvailable(option, modelName);
              return (
                <button
                  ref={(element) => {
                    if (element) optionRefs.current.set(option.value, element);
                    else optionRefs.current.delete(option.value);
                  }}
                  id={`${listboxId}-${option.value}`}
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={!available}
                  className={[
                    index === activeIndex ? "active" : "",
                    option.description ? "has-description" : ""
                  ].filter(Boolean).join(" ") || undefined}
                  disabled={!available}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => { if (available) setActiveIndex(index); }}
                  onClick={() => selectOption(option)}
                >
                  <span className="language-combobox-option-label">{option.label}</span>
                  <small className="language-combobox-option-code">{option.value}</small>
                  {option.description ? (
                    <span className="language-combobox-option-description">{option.description}</span>
                  ) : null}
                </button>
              );
            })}
            {!matchingOptions.length ? (
              <div className="language-combobox-empty">No matching languages</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
