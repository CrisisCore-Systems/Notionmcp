"use client";

import { formatPropertyTypeLabel } from "./chat-utils";
import type { PropertyType } from "./types";

type SchemaEditorProps = {
  schemaEntries: [string, PropertyType][];
  propertyTypes: PropertyType[];
  historyIndex: number;
  historyLength: number;
  onUndo: () => void;
  onRedo: () => void;
  onAddColumn: () => void;
  onRenameColumn: (currentName: string, nextName: string) => void;
  onUpdateColumnType: (columnName: string, nextType: PropertyType) => void;
  onDeleteColumn: (columnName: string) => void;
};

export function SchemaEditor({
  schemaEntries,
  propertyTypes,
  historyIndex,
  historyLength,
  onUndo,
  onRedo,
  onAddColumn,
  onRenameColumn,
  onUpdateColumnType,
  onDeleteColumn,
}: SchemaEditorProps) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ fontSize: "0.85rem", color: "#555" }}>
          Schema ({schemaEntries.length} properties)
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            onClick={onUndo}
            disabled={historyIndex <= 0}
            style={{
              padding: "0.45rem 0.8rem",
              background: historyIndex <= 0 ? "#f3f4f6" : "none",
              border: "1px solid #ddd",
              borderRadius: 8,
              cursor: historyIndex <= 0 ? "default" : "pointer",
              fontSize: "0.8rem",
              color: "#333",
            }}
          >
            Undo
          </button>
          <button
            onClick={onRedo}
            disabled={historyIndex >= historyLength - 1}
            style={{
              padding: "0.45rem 0.8rem",
              background: historyIndex >= historyLength - 1 ? "#f3f4f6" : "none",
              border: "1px solid #ddd",
              borderRadius: 8,
              cursor: historyIndex >= historyLength - 1 ? "default" : "pointer",
              fontSize: "0.8rem",
              color: "#333",
            }}
          >
            Redo
          </button>
          <button
            onClick={onAddColumn}
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
            + Add column
          </button>
        </div>
      </div>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {schemaEntries.map(([name, type], index) => (
          <div
            key={`${name}-${index}`}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(180px, 1fr) minmax(140px, 180px) auto",
              gap: "0.5rem",
              alignItems: "center",
            }}
          >
            <input
              aria-label={`Column name ${index + 1}`}
              value={name}
              onChange={(e) => onRenameColumn(name, e.target.value)}
              style={{
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: 6,
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <select
              aria-label={`Column type for ${name}`}
              value={type}
              onChange={(e) => onUpdateColumnType(name, e.target.value as PropertyType)}
              style={{
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: 6,
                width: "100%",
                boxSizing: "border-box",
              }}
            >
              {propertyTypes.map((propertyType) => (
                <option key={propertyType} value={propertyType}>
                  {formatPropertyTypeLabel(propertyType)}
                </option>
              ))}
            </select>
            <button
              onClick={() => onDeleteColumn(name)}
              aria-label={`Delete column ${name}`}
              style={{
                padding: "0.45rem 0.8rem",
                background: "none",
                border: "1px solid #f5c2c7",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: "0.8rem",
                color: "#b42318",
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
