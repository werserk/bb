import { ThreadPlanSteps } from "./ThreadPlanSteps";
export function ThreadPlanCard({ threadId }: { threadId: string }) {
  return (
    <div className="pointer-events-none absolute right-4 top-3 z-10 max-w-[calc(100%-2rem)]">
      <ThreadPlanSteps threadId={threadId} placement="overlay" />
    </div>
  );
}
