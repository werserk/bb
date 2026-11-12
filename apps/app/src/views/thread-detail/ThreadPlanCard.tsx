import { ThreadPlanSteps } from "./ThreadPlanSteps";
export function ThreadPlanCard({ threadId }: { threadId: string }) {
  return (
    <div className="px-3 pb-1" data-thread-plan-dock="">
      <ThreadPlanSteps threadId={threadId} placement="overlay" compact />
    </div>
  );
}
