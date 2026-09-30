export default function EventLog({ events }) {
  const rows = [...events].reverse()
  return (
    <div className="max-h-[220px] space-y-1 overflow-y-auto text-xs text-muted-foreground">
      {rows.map((e, i) => (
        <div key={i} className="flex gap-3">
          <span className="w-[68px] shrink-0 text-muted-foreground/70">
            {new Date(e.ts).toLocaleTimeString()}
          </span>
          <span>{e.message}</span>
        </div>
      ))}
    </div>
  )
}
