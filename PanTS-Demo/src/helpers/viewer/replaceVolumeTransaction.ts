/** Keep the previous volume alive until its replacement is loaded and attached. */
export async function replaceVolumeTransaction(actions: {
  load: () => Promise<void>;
  activate: () => Promise<void>;
  restore: () => Promise<void>;
  retirePrevious: () => void;
  discardReplacement: () => void;
}): Promise<void> {
  let activationStarted = false;
  try {
    await actions.load();
    activationStarted = true;
    await actions.activate();
  } catch (error) {
    // If restoration itself fails, retain both caches. A viewport may still
    // refer to the replacement; releasing it would create a dangling actor.
    if (activationStarted) await actions.restore();
    actions.discardReplacement();
    throw error;
  }
  actions.retirePrevious();
}
