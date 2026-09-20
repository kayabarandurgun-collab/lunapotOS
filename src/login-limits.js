// A shared gateway/NAT address must not put every staff account in one ten-attempt bucket.
// Keep a bounded IP-wide bucket as well as the stricter per-account/action bucket.
export function loginLimitSubjects(path, input, ip) {
  const action = path.split('/').at(-1);
  const supplied = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
  const account = !supplied || supplied === 'admin' || supplied === 'owner' ? 'owner' : supplied;
  return [
    {subject: JSON.stringify(['ip', ip]), max: 100},
    {subject: JSON.stringify(['login', ip, action, action === 'login' ? account : '']), max: 10},
    // IP değiştirerek aynı hesabı denemeyi de sınırla (dağıtık deneme): hesap başına 25.
    ...(action === 'login' ? [{subject: JSON.stringify(['account', account]), max: 25}] : []),
  ];
}

// Fixed windows, atomic reservation, saturated counters. Failed and successful attempts both consume budget.
// Neither parallel requests nor successful PINs reset an in-flight failure budget.
export async function takeLoginBudget(db,subject,max,seconds=900,time=Math.floor(Date.now()/1000)){
 const key=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subject));
 const digest=Array.from(new Uint8Array(key),b=>b.toString(16).padStart(2,'0')).join('');
 const row=await db.prepare(`INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?)
  ON CONFLICT(key) DO UPDATE SET
  attempts=CASE WHEN reset_at<=? THEN 1 ELSE MIN(attempts+1,?) END,
  reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING attempts`).bind(digest,time+seconds,time,max+1,time).first();
 if(!row||row.attempts>max)throw Object.assign(Error('İşlem doğrulanamadı. Şifrenizle giriş yapın veya 15 dakika sonra tekrar deneyin.'),{status:429});
}
