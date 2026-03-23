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
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ fontSize: "0.85rem", color: "#555" }}>
          Rows ({editedResult.items.length})
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            onClick={onToggleFindReplace}
            style={{
              padding: "0.45rem 0.8rem",
              background: "none",
              border: "1px solid #ddd",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: "0.8rem",
              color: "#333",
            }}
          >
            {showFindReplace ? "Hide replace" : "Find & replace"}
          </button>
          <button
            onClick={onExportJson}
            style={{
              padding: "0.45rem 0.8rem",
              background: "none",
              border: "1px solid #ddd",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: "0.8rem",
              color: "#333",
            }}
          >
            Download JSON
          </button>
          <button
            onClick={onExportCsv}
            style={{
              padding: "0.45rem 0.8rem",
              background: "none",
              border: "1px solid #ddd",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: "0.8rem",
              color: "#333",
            }}
          >
            Download CSV
          </button>
        </div>
      </div>

      {showFindReplace && (
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.85rem",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            background: "#fafafa",
          }}
        >
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
              style={{
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: 6,
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <input
              value={replaceText}
              onChange={(e) => onReplaceTextChange(e.target.value)}
              placeholder="Replace with"
              style={{
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: 6,
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <button
              onClick={onReplaceAcrossRows}
              disabled={!findText}
              style={{
                padding: "0.5rem 0.85rem",
                background: findText ? "#111827" : "#d1d5db",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: findText ? "pointer" : "default",
                fontSize: "0.8rem",
              }}
            >
              Replace all
            </button>
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto", marginBottom: "1.25rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              {schemaEntries.map(([columnName]) => (
                <th
                  key={columnName}
                  style={{
                    padding: "0.5rem 0.75rem",
                    textAlign: "left",
                    fontWeight: 500,
                    border: "1px solid #e5e7eb",
                    whiteSpace: "nowrap",
                  }}
                >
                  {columnName}
                </th>
              ))}
              <th
                style={{
                  padding: "0.5rem 0.75rem",
                  textAlign: "left",
                  fontWeight: 500,
                  border: "1px solid #e5e7eb",
                  whiteSpace: "nowrap",
                }}
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {editedResult.items.length === 0 ? (
              <tr>
                <td
                  colSpan={schemaEntries.length + 1}
                  style={{
                    padding: "0.75rem",
                    border: "1px solid #e5e7eb",
                    color: "#666",
                  }}
                >
                  All rows removed. Use the “Start over” button below to regenerate results.
                </td>
              </tr>
            ) : (
              editedResult.items.map((item, rowIndex) => {
                const provenance = getItemProvenance(item);

                return (
                  <tr key={rowIndex} style={{ borderBottom: "1px solid #e5e7eb" }}>
                    {schemaEntries.map(([columnName, columnType]) => (
                      <td
                        key={columnName}
                        style={{
                          padding: "0.5rem 0.75rem",
                          border: "1px solid #e5e7eb",
                          minWidth: 180,
                          verticalAlign: "top",
                        }}
                      >
                        <textarea
                          aria-label={`${columnName} for row ${rowIndex + 1}`}
                          value={getItemTextValue(item, columnName)}
                          onChange={(e) => onUpdateItemValue(rowIndex, columnName, e.target.value)}
                          rows={columnType === "rich_text" ? 3 : 2}
                          style={{
                            width: "100%",
                            border: invalidCellLookup.has(`${rowIndex}:${columnName}`)
                              ? "1px solid #f59e0b"
                              : "1px solid #ddd",
                            borderRadius: 6,
                            padding: "0.45rem 0.5rem",
                            fontSize: "0.85rem",
                            fontFamily: "inherit",
                            boxSizing: "border-box",
                            background: invalidCellLookup.has(`${rowIndex}:${columnName}`)
                              ? "#fffbeb"
                              : "#fff",
                            resize: "vertical",
                          }}
                        />
                      </td>
                    ))}
                    <td
                      style={{
                        padding: "0.5rem 0.75rem",
                        border: "1px solid #e5e7eb",
                        verticalAlign: "top",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        <button
                          onClick={() => onMoveItem(rowIndex, -1)}
                          disabled={rowIndex === 0}
                          aria-label={`Move row ${rowIndex + 1} up`}
                          style={{
                            padding: "0.45rem 0.7rem",
                            background: rowIndex === 0 ? "#f3f4f6" : "none",
                            border: "1px solid #ddd",
                            borderRadius: 6,
                            cursor: rowIndex === 0 ? "default" : "pointer",
                            fontSize: "0.8rem",
                            color: "#333",
                          }}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => onMoveItem(rowIndex, 1)}
                          disabled={rowIndex === editedResult.items.length - 1}
                          aria-label={`Move row ${rowIndex + 1} down`}
                          style={{
                            padding: "0.45rem 0.7rem",
                            background:
                              rowIndex === editedResult.items.length - 1 ? "#f3f4f6" : "none",
                            border: "1px solid #ddd",
                            borderRadius: 6,
                            cursor:
                              rowIndex === editedResult.items.length - 1 ? "default" : "pointer",
                            fontSize: "0.8rem",
                            color: "#333",
                          }}
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => onDuplicateItem(rowIndex)}
                          aria-label={`Duplicate row ${rowIndex + 1}`}
                          style={{
                            padding: "0.45rem 0.7rem",
                            background: "none",
                            border: "1px solid #ddd",
                            borderRadius: 6,
                            cursor: "pointer",
                            fontSize: "0.8rem",
                            color: "#333",
                          }}
                        >
                          Copy
                        </button>
                        <button
                          onClick={() => onRemoveItem(rowIndex)}
                          aria-label={`Remove row ${rowIndex + 1}`}
                          style={{
                            padding: "0.45rem 0.7rem",
                            background: "none",
                            border: "1px solid #f5c2c7",
                            borderRadius: 6,
                            cursor: "pointer",
                            fontSize: "0.8rem",
                            color: "#b42318",
                          }}
                        >
                          Remove
                        </button>
                      </div>
                      {provenance && (
                        <div style={{ marginTop: "0.6rem", display: "grid", gap: "0.35rem", maxWidth: 260 }}>
                          <div style={{ fontSize: "0.75rem", color: "#475569", whiteSpace: "normal" }}>
                            Sources: {provenance.sourceUrls.join(", ")}
                          </div>
                          {provenance.evidenceByField && (
                            <div style={{ fontSize: "0.75rem", color: "#64748b", whiteSpace: "normal" }}>
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
