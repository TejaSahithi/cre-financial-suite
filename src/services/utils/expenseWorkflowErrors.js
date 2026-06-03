export class ClassificationEligibilityError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = "ClassificationEligibilityError";
    this.reason = reason || null;
  }
}

export class CamEligibilityError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = "CamEligibilityError";
    this.reason = reason || null;
  }
}
