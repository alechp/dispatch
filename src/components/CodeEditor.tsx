import { useEffect, useRef, useCallback } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim } from "@replit/codemirror-vim";
import { basicSetup } from "codemirror";

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: "toml" | "json";
  readOnly?: boolean;
  vimEnabled?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  vimEnabled = false,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const vimCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);

  // Keep onChange ref current without triggering editor recreation
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const langExtension =
      language === "json" ? json() : StreamLanguage.define(toml);

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && onChangeRef.current) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    // Stop ESC from bubbling when vim is active (prevents closing panels)
    const escTrap = keymap.of([
      {
        key: "Escape",
        run: () => {
          // Let vim handle ESC internally; just stop propagation
          return false;
        },
      },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        vimCompartment.current.of(vimEnabled ? vim() : []),
        basicSetup,
        languageCompartment.current.of(langExtension),
        readOnlyCompartment.current.of(
          EditorState.readOnly.of(readOnly)
        ),
        oneDark,
        updateListener,
        escTrap,
        EditorView.theme({
          "&": {
            fontSize: "12px",
            maxHeight: "calc(100vh - 280px)",
            border: "1px solid var(--color-border-subtle, #333)",
            borderRadius: "6px",
          },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          },
          ".cm-gutters": {
            borderRight: "1px solid var(--color-border-subtle, #333)",
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only create editor once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure language when it changes
  useEffect(() => {
    if (!viewRef.current) return;
    const langExtension =
      language === "json" ? json() : StreamLanguage.define(toml);
    viewRef.current.dispatch({
      effects: languageCompartment.current.reconfigure(langExtension),
    });
  }, [language]);

  // Reconfigure readOnly when it changes
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        EditorState.readOnly.of(readOnly)
      ),
    });
  }, [readOnly]);

  // Reconfigure vim when it changes
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: vimCompartment.current.reconfigure(
        vimEnabled ? vim() : []
      ),
    });
  }, [vimEnabled]);

  // Update content when value changes externally (e.g. switching TOML/JSON)
  useEffect(() => {
    if (!viewRef.current) return;
    const currentContent = viewRef.current.state.doc.toString();
    if (currentContent !== value) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: value,
        },
      });
    }
  }, [value]);

  // Stop ESC from bubbling out of the editor container when vim is active
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (vimEnabled && e.key === "Escape") {
        e.stopPropagation();
      }
    },
    [vimEnabled]
  );

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      className="code-editor-container"
    />
  );
}
