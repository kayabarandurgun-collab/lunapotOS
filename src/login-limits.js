// A shared gateway/NAT address must not put every staff account in one ten-attempt bucket.
// Keep a bounded IP-wide bucket as well as the stricter per-account/action bucket.
export function loginLimitSubjects(path, input, ip) {
  const action = path.split('/').at(-1);
  const supplied = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
  const account = !supplied || supplied === 'admin' || supplied === 'owner' ? 'owner' : supplied;
  return [
    {subject: JSON.stringify(['ip', ip]), max: 100},
    {subject: JSON.stringify(['login', ip, action, action === 'login' ? account : '']), max: 10},
  ];
}
