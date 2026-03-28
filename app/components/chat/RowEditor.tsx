"use client";

import { getItemProvenance, getItemTextValue } from "./chat-utils";
import type { EditableResult, PropertyType } from "./types";

type RowEditorProps = {
  editedResult: EditableResult;
  schemaEntries: [string, PropertyType][];
  invalidCellLookup: Set<string>;
  showFindReplace: boolean;
  findText: string;
  replaceText: string;
  onToggleFindReplace: () => void;
  onFindTextChange: (value: string) => void;
  onReplaceTextChange: (value: string) => void;
  onReplaceAcrossRows: () => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onUpdateItemValue: (rowIndex: number, columnName: string, value: string) => void;
  onMoveItem: (rowIndex: number, direction: -1 | 1) => void;
  onDuplicateItem: (rowIndex: number) => void;
  onRemoveItem: (rowIndex: number) => void;
};

export function RowEditor({
  editedResult,
  schemaEntries,
  invalidCellLookup,
  showFindReplace,
  findText,
  replaceText,
  onToggleFindReplace,
  onFindTextChange,
  onReplaceTextChange,
  onReplaceAcrossRows,
  onExportJson,
  onExportCsv,
  onUpdateItemValue,
  onMoveItem,
  onDuplicateItem,
  onRemoveItem,
}: RowEditorProps) {
  return (
    <>
      <div className="editor-toolbar">
        <div className="editor-toolbar__title">
          Rows ({editedResult.items.length})
        </div>
        <div className="editor-toolbar__actions">
          <button
            onClick={onToggleFindReplace}
            className="operator-button-secondary"
          >
            {showFindReplace ? "Hide replace" : "Find & replace"}
          </button>
          <button
            onClick={onExportJson}
            className="operator-button-secondary"
          >
            Download JSON
          </button>
          <button
            onClick={onExportCsv}
            className="operator-button-secondary"
          >
            Download CSV
          </button>
        </div>
      </div>

      {showFindReplace && (
        <div className="editor-panel">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(180px, 1fr) minmax(180px, 1fr) auto",
              gap: "0.5rem",
              alignItems: "center",
            }}
          >
            <input
              value={findText}
              onChange={(e) => onFindTextChange(e.target.value)}
              placeholder="Find text"
              className="editor-input"
            />
            <input
              value={replaceText}
              onChange={(e) => onReplaceTextChange(e.target.value)}
              placeholder="Replace with"
              className="editor-input"
            />
            <button
              onClick={onReplaceAcrossRows}
              disabled={!findText}
              className="operator-button"
            >
              Replace all
            </button>
          </div>
        </div>
      )}

      <div className="editor-table-shell">
        <table className="editor-table">
          <thead>
            <tr>
              {schemaEntries.map(([columnName]) => (
                <th
                  key={columnName}
                >
                  {columnName}
                </th>
              ))}
              <th>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {editedResult.items.length === 0 ? (
              <tr>
                <td
                  colSpan={schemaEntries.length + 1}
                  style={{ color: "#666" }}
                >
                  All rows removed. Use the “Reset packet” button below to regenerate results.
                </td>
              </tr>
            ) : (
              editedResult.items.map((item, rowIndex) => {
                const provenance = getItemProvenance(item);

                return (
                  <tr key={rowIndex}>
                    {schemaEntries.map(([columnName, columnType]) => (
                      <td
                        key={columnName}
                        style={{ minWidth: 180 }}
                      >
                        <textarea
                          aria-label={`${columnName} for row ${rowIndex + 1}`}
                          value={getItemTextValue(item, columnName)}
                          onChange={(e) => onUpdateItemValue(rowIndex, columnName, e.target.value)}
                          rows={columnType === "rich_text" ? 3 : 2}
                          className="editor-textarea"
                          style={{
                            borderColor: invalidCellLookup.has(`${rowIndex}:${columnName}`)
                              ? "#f59e0b"
                              : undefined,
                            background: invalidCellLookup.has(`${rowIndex}:${columnName}`)
                              ? "#fffbeb"
                              : undefined,
                          }}
                        />
                      </td>
                    ))}
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        <button
                          onClick={() => onMoveItem(rowIndex, -1)}
                          disabled={rowIndex === 0}
                          aria-label={`Move row ${rowIndex + 1} up`}
                          className="operator-button-secondary"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => onMoveItem(rowIndex, 1)}
                          disabled={rowIndex === editedResult.items.length - 1}
                          aria-label={`Move row ${rowIndex + 1} down`}
                          className="operator-button-secondary"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => onDuplicateItem(rowIndex)}
                          aria-label={`Duplicate row ${rowIndex + 1}`}
                          className="operator-button-secondary"
                        >
                          Copy
                        </button>
                        <button
                          onClick={() => onRemoveItem(rowIndex)}
                          aria-label={`Remove row ${rowIndex + 1}`}
                          className="operator-button-secondary"
                        >
                          Remove
                        </button>
                      </div>
                      {provenance && (
                        <div className="editor-provenance">
                          <div>
                            Sources:{" "}
                            {provenance.sourceUrls.map((sourceUrl, sourceIndex) => (
                              <span key={sourceUrl}>
                                <a
                                  href={sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {sourceUrl}
                                </a>
                                {sourceIndex < provenance.sourceUrls.length - 1 ? ", " : ""}
                              </span>
                            ))}
                          </div>
                          {provenance.evidenceByField && (
                            <div>
                              Evidence: {Object.keys(provenance.evidenceByField).join(", ")}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
