import { ThreadTodoCard } from "./ThreadTodoCard";
export default { title: "thread/Canonical plan" };
export const Active = () => (
  <div className="w-[340px]">
    <ThreadTodoCard
      threadId="fixture"
      placement="overlay"
      narrow={false}
      earlier={false}
      executing
      interactions={[]}
      snapshot={{
        sourceSeq: 1,
        updatedAt: 0,
        planId: "fixture",
        items: [
          {
            id: "done",
            text: "Read sources",
            status: "completed",
            interactionIds: [],
          },
          {
            id: "active",
            text: "Verify implementation",
            status: "in_progress",
            note: "Checking native input",
            actor: "reviewer",
            interactionIds: [],
          },
          {
            id: "next",
            text: "Deliver",
            status: "pending",
            interactionIds: [],
          },
        ],
      }}
    />
  </div>
);
export const Finished = () => (
  <div className="w-[340px]">
    <ThreadTodoCard
      threadId="fixture"
      placement="overlay"
      narrow={false}
      earlier={false}
      executing={false}
      interactions={[]}
      snapshot={{
        sourceSeq: 2,
        updatedAt: 0,
        items: [
          {
            id: "done",
            text: "Delivered",
            status: "completed",
            interactionIds: [],
          },
        ],
      }}
    />
  </div>
);
