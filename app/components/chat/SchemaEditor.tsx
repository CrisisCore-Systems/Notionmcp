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
    <div className="editor-panel">
      <div className="editor-toolbar">
        <div className="editor-toolbar__title">
          Schema ({schemaEntries.length} properties)
        </div>
        <div className="editor-toolbar__actions">
          <button
            onClick={onUndo}
            disabled={historyIndex <= 0}
            className="operator-button-secondary"
          >
            Undo
          </button>
          <button
            onClick={onRedo}
            disabled={historyIndex >= historyLength - 1}
            className="operator-button-secondary"
          >
            Redo
          </button>
          <button
            onClick={onAddColumn}
            className="operator-button"
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
              className="editor-input"
            />
            <select
              aria-label={`Column type for ${name}`}
              value={type}
              onChange={(e) => onUpdateColumnType(name, e.target.value as PropertyType)}
              className="editor-select"
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
              className="operator-button-secondary"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
