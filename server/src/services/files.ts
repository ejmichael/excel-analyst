/**
 * Deletes every storage object belonging to a workspace (raw uploads and normalised files).
 * Stub for Part 1: there are no datasets yet. Part 2 fills this in; it must run before the
 * workspace row is deleted, because the cascade removes the dataset rows that hold the paths.
 */
export async function deleteWorkspaceFiles(_ownerId: string, _workspaceId: string): Promise<void> {
  // Intentionally empty until Part 2 (uploads).
}
