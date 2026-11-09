import type { PresenceUser } from '@kanban/shared';

/** Who is on the board right now (and, where known, which card they are editing). */
export const PresenceBar = ({
  users,
  currentUserId,
}: {
  users: PresenceUser[];
  currentUserId: string;
}) => (
  <ul aria-label="People on this board" className="flex flex-wrap items-center gap-2">
    {users.map(({ user }) => (
      <li
        key={user.id}
        title={user.id === currentUserId ? `${user.name} (you)` : user.name}
        className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
      >
        <span
          aria-hidden
          className="grid h-5 w-5 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
        >
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span>{user.id === currentUserId ? 'You' : user.name}</span>
      </li>
    ))}
  </ul>
);
