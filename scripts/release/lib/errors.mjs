/** A failure the controller cannot get past without guessing. Carries a stable, named code. */
export class ControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
