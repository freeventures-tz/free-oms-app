/**
 * The write sequence every tag the controller publishes goes through, build or normal: create the annotated
 * tag object, create a reference to it that is never forced, then read the reference and the object back
 * from GitHub. Nothing is reported as published until the read-back agrees.
 *
 * The caller decides what the read-back must show and what an existing name means. This module only keeps
 * the sequence and its failures the same for both kinds of tag:
 *
 *   tag_object_not_created     no object was created, so nothing was published
 *   tag_reference_unconfirmed  an object exists but no reference to it was confirmed; an unreferenced object
 *                              is not a publication, and a retry reads the references again
 *   tag_readback_failed        the reference may exist, but it could not be read back; a retry confirms it
 */

import { ControllerError } from "./errors.mjs";

/**
 * Creates `name` as an annotated tag of `sha`. `readBack(name)` returns `{ state: "missing" | "matches" |
 * "conflict", ... }` from GitHub. `beforeReference(object)` runs between the object and the reference, and
 * may throw to stop before the reference is created. `what` names the tag in messages.
 *
 * Returns `{ created: true, object, confirmed }` when the reference was created, and `{ created: false,
 * object, confirmed }` when GitHub refused the name because it exists. `confirmed` is the read-back; the
 * caller judges it.
 */
export async function createAnnotatedTag({ writer, name, message, sha, readBack, beforeReference, what }) {
  let object;
  try {
    object = await writer.createTagObject({ tag: name, message, commit: sha });
  } catch (error) {
    if (!(error instanceof ControllerError)) throw error;
    throw new ControllerError("tag_object_not_created", `no ${what.noun} was published for ${sha}: ${error.message}`);
  }

  if (beforeReference) await beforeReference(object);

  let reference;
  try {
    reference = await writer.createTagReference({ tag: name, object: object.sha });
  } catch (error) {
    if (!(error instanceof ControllerError)) throw error;
    throw new ControllerError(
      "tag_reference_unconfirmed",
      `tag object ${object.sha} for ${name} exists, but its reference was not confirmed (${error.message}). An unreferenced tag object is not ${what.publication}; a retry reads the references again`,
    );
  }

  let confirmed;
  try {
    confirmed = await readBack(name);
  } catch (error) {
    if (!(error instanceof ControllerError)) throw error;
    throw new ControllerError(
      "tag_readback_failed",
      `${name} could not be read back (${error.message}); nothing is reported as published, and a retry confirms it from GitHub`,
    );
  }

  if (!reference.created && confirmed.state === "missing") {
    throw new ControllerError(
      "tag_reference_unconfirmed",
      `GitHub refused refs/tags/${name} and no such reference exists; tag object ${object.sha} is unreferenced and nothing is published`,
    );
  }
  return { created: reference.created, object, confirmed };
}
