import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export function AutoResizeTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [props.value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
    />
  );
}
