import { TASK_ARCHIVE_REASONS, type Feature } from '@automaker/types';
export function TaskArchiveDetails({ feature }: { feature: Feature }) {
  const records = feature.archiveHistory ?? (feature.archive ? [feature.archive] : []);
  if (!records.length) return null;
  return (
    <details
      className="my-2 rounded border p-2 text-xs"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <summary className="cursor-pointer">
        Archive history{feature.archive ? ` · ${TASK_ARCHIVE_REASONS[feature.archive.reason]}` : ''}
      </summary>
      {records
        .slice()
        .reverse()
        .map((record, index) => (
          <div key={index} className="mt-2 space-y-1 border-t pt-2">
            <p>
              {TASK_ARCHIVE_REASONS[record.reason]} · {new Date(record.archivedAt).toLocaleString()}
            </p>
            <p className="whitespace-pre-wrap break-words">{record.description}</p>
            {record.duplicateOf && (
              <p>
                Duplicate of:{' '}
                {record.duplicateTitle || record.duplicateJiraKey || record.duplicateOf} (
                {record.duplicateOf})
              </p>
            )}
            {record.restoredAt && <p>Restored: {new Date(record.restoredAt).toLocaleString()}</p>}
          </div>
        ))}
    </details>
  );
}
