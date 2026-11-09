/**
 * Sends the file straight to object storage with the signed form from the API. `fetch` cannot
 * report upload progress, so this uses XMLHttpRequest.
 */
export const uploadWithProgress = (
  form: { url: string; fields: Record<string, string> },
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(form.fields)) data.append(key, value);
    data.append('file', file); // must come last
    const request = new XMLHttpRequest();
    request.open('POST', form.url);
    request.upload.onprogress = (event) =>
      event.lengthComputable && onProgress(event.loaded / event.total);
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`The file was rejected by storage (${request.status}).`));
    request.onerror = () => reject(new Error('The upload failed. Check your connection.'));
    request.send(data);
  });
