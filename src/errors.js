export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const notFound = (message = 'Dokumen tidak ditemukan') => new HttpError(404, message);
export const forbidden = (message = 'Akses ditolak') => new HttpError(403, message);
export const conflict = (message) => new HttpError(409, message);
export const unprocessable = (message) => new HttpError(422, message);
