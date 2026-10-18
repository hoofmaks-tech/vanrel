/** The only error of the QC layer. extends Error: stack + instanceof work. */
export class QcError extends Error {
	readonly kind = "qc";
	constructor(message: string) {
		super(message);
		this.name = "QcError";
	}
}
