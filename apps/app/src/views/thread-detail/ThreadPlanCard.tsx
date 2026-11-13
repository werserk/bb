import { useComposerContextSource } from "@/components/promptbox/context/composer-context";
import { ThreadComposerPlan } from "@/components/promptbox/context/ThreadComposerPlan";
import { ThreadPlanSteps } from "./ThreadPlanSteps";
export function ThreadPlanCard({ threadId }: { threadId: string }) {
  const contextSource = useComposerContextSource();
  if (contextSource)
    return (
      <div data-thread-plan-dock="">
        <ThreadComposerPlan threadId={threadId} />
      </div>
    );
  return (
    <div className="px-3 pb-1" data-thread-plan-dock="">
      <ThreadPlanSteps threadId={threadId} placement="overlay" compact />
    </div>
  );
}
