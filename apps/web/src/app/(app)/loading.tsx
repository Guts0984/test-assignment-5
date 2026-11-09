export default function Loading() {
  return (
    <div
      className="mx-auto max-w-3xl animate-pulse space-y-4 p-6"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="h-8 w-1/3 rounded bg-muted" />
      <div className="h-24 rounded bg-muted" />
      <div className="h-24 rounded bg-muted" />
    </div>
  );
}
