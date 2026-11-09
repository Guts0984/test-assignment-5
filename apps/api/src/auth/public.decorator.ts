import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Marks a route (or controller) that works without signing in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
