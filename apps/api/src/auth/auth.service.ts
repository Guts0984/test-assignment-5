import { hashPassword, users, verifyPassword, type DatabaseHandle } from '@kanban/db';
import type { Me, RegisterBody } from '@kanban/shared';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { AppError } from '../common/app-error';
import { DATABASE } from '../infra/tokens';
import { SessionService } from './session.service';

type PgError = { code?: string; constraint?: string; cause?: PgError };

/** The Postgres error behind a Drizzle error (Drizzle wraps it in `cause`). */
const pgErrorOf = (error: unknown): PgError | undefined => {
  for (let current = error as PgError | undefined, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) return current;
    current = current.cause;
  }
  return undefined;
};

@Injectable()
export class AuthService {
  // A real hash to compare against when the email is unknown, so "no such user" and "wrong
  // password" take the same time and give the same answer.
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** Creates the account and its session in one step; if the session cannot be created, nothing is kept. */
  async register(body: RegisterBody): Promise<{ user: Me; sessionId: string }> {
    const passwordHash = await hashPassword(body.password);
    try {
      return await this.database.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({ email: body.email, handle: body.handle, name: body.name, passwordHash })
          .returning({ id: users.id, email: users.email, handle: users.handle, name: users.name });
        if (!row) throw new Error('user insert returned nothing');
        return { user: row, sessionId: await this.sessions.create(row) };
      });
    } catch (error) {
      const pg = pgErrorOf(error);
      if (pg?.code === '23505') {
        const field = pg.constraint?.includes('handle') ? 'handle' : 'email';
        throw new AppError('conflict', `This ${field} is already taken`, { field });
      }
      throw error;
    }
  }

  async login(email: string, password: string): Promise<{ user: Me; sessionId: string }> {
    const [row] = await this.database.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    this.dummyHash ??= hashPassword('not-a-real-password');
    const valid = await verifyPassword(password, row?.passwordHash ?? (await this.dummyHash));
    if (!row || !valid) throw new AppError('unauthorized', 'Invalid email or password');

    const user: Me = { id: row.id, email: row.email, handle: row.handle, name: row.name };
    return { user, sessionId: await this.sessions.create(user) };
  }
}
