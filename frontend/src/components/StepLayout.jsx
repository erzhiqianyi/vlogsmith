import { cn } from '@/lib/utils'

// One step's page inside the job view: a scrolling body plus a footer bar that holds
// the step's primary action on the right.
export default function StepLayout({ children, footer, className }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-8', className)}>{children}</div>
      {footer && (
        <footer className="flex h-[76px] shrink-0 items-center justify-end gap-3 border-t bg-background px-10">
          {footer}
        </footer>
      )}
    </div>
  )
}
