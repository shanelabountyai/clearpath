import { startBreakGlass } from '../actions';
import { BreakGlassDialog } from '@/src/ui/primitives';

/**
 * The app-side binding: the dialog itself lives in primitives (it is part of
 * the visual vocabulary), and this file is only where it meets the server
 * action - primitives never import from app/.
 */
export function BreakGlassPrompt({ resource }: { resource: string }) {
  return <BreakGlassDialog resource={resource} action={startBreakGlass} />;
}
