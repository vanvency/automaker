import { TASK_ARCHIVE_REASONS, type Feature } from '@automaker/types';
export function TaskArchiveDetails({
  feature,
  expanded = false,
}: {
  feature: Feature;
  expanded?: boolean;
}) {
  const records = [...(feature.archiveHistory ?? [])];
  if (
    feature.archive &&
    !records.some((record) => record.archivedAt === feature.archive!.archivedAt)
  ) {
    records.push(feature.archive);
  }
  if (!records.length) {
    if (feature.status !== 'completed') return null;
    return (
      <div className="my-2 rounded border p-2 text-xs space-y-1">
        <p className="font-medium">
          Archive reason:{' '}
          {feature.deliveryCompletion?.status === 'succeeded'
            ? 'Delivery completed'
            : 'Not recorded (legacy task)'}
        </p>
        {feature.deliveryCompletion?.status === 'succeeded' && (
          <>
            <p className="text-muted-foreground">
              Based on the saved delivery receipt; the legacy completion flow did not record a
              separate archive reason.
            </p>
            {feature.deliveryCompletion.steps.map(
              (step) =>
                step.message && (
                  <p key={step.id} className="whitespace-pre-wrap break-words">
                    {step.message}
                  </p>
                )
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <details
      className="my-2 rounded border p-2 text-xs"
      open={expanded || undefined}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <summary className="cursor-pointer">
        Archive history
        {feature.archive
          ? ` · ${TASK_ARCHIVE_REASONS[feature.archive.reason] || feature.archive.reason}`
          : ''}
      </summary>
      {records
        .slice()
        .reverse()
        .map((record, index) => (
          <div key={index} className="mt-2 space-y-1 border-t pt-2">
            <p>
              Archive reason: {TASK_ARCHIVE_REASONS[record.reason] || record.reason} ·{' '}
              {new Date(record.archivedAt).toLocaleString()}
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
