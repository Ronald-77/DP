const selectedUserKey = 'custodia-user';
export const getSelectedUser = () => localStorage.getItem(selectedUserKey) || 'usr-morgan';
export const setSelectedUser = (id: string) => localStorage.setItem(selectedUserKey, id);

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'x-user-id': getSelectedUser(), ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((item: { msg?: string }) => item.msg).filter(Boolean).join(', ')
      : body.detail;
    throw new Error(body.error || detail || 'Request failed');
  }
  return response.json() as Promise<T>;
}

export function downloadEvidence(id: string, version?: number) {
  fetch(`/api/evidence/${id}/download${version ? `?version=${version}` : ''}`, { headers: { 'x-user-id': getSelectedUser() } })
    .then(async (response) => {
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || body.detail || 'Download failed');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
      const filename = encodedName ? decodeURIComponent(encodedName) : disposition.match(/filename="(.+)"/)?.[1] || 'evidence.bin';
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
    });
}
