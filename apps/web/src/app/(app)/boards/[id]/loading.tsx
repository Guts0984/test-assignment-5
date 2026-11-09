export default function Loading() {
  return (
    <div className="flex animate-pulse gap-3 p-4" aria-busy="true" aria-label="Loading the board">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-96 w-72 shrink-0 rounded-lg bg-muted" />
      ))}
    </div>
  );
}
