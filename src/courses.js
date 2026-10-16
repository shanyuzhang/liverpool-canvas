// Course lists, grouped the way students think about them: this term first, then earlier
// terms, then sites that are not taught courses (orientation, careers, societies …).

export async function listCourses(client, { includePast = false } = {}) {
  const raw = (await client.list('courses', { include: ['term'], ...(includePast ? {} : { enrollment_state: 'active' }) })).filter((x) => x.id && x.name);
  for (const c of raw) client.courseInfo.set(String(c.id), c);
  return normaliseCourses(raw);
}

export function normaliseCourses(raw, now = new Date().toISOString()) {
  // Schools often leave last term's courses "active" for months, so "current" means the term
  // that started most recently. Courses without a dated term are other sites.
  const starts = raw.map((x) => x.term?.start_at).filter((s) => s && s <= now).sort();
  const latest = starts[starts.length - 1];
  return raw.map((x) => {
    const dated = !!x.term?.start_at;
    const group = !dated ? 'other' : x.term.start_at === latest ? 'current' : x.term.start_at > now ? 'upcoming' : 'past';
    return {
      id: String(x.id), code: x.course_code || '', name: x.name, term: x.term?.name || null,
      termStart: x.term?.start_at || null, group, current: group === 'current',
    };
  }).sort((a, b) => order(a) - order(b) || String(b.termStart || '').localeCompare(String(a.termStart || '')) || a.code.localeCompare(b.code));
}

const order = (c) => ({ current: 0, upcoming: 1, past: 2, other: 3 })[c.group];

export function groupCourses(courses) {
  const groups = [];
  for (const c of courses) {
    const key = c.group === 'other' ? 'other' : `term:${c.term || c.termStart}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, label: c.group === 'other' ? null : c.term, kind: c.group, courses: [] });
    g.courses.push(c);
  }
  return groups;
}

// "MATH253" → the matching courses. A Canvas id, an exact code, or a code followed by a term or
// section suffix (MATH253-202526) count as matches. More than one match is returned as is: the
// caller asks which one, it never guesses.
export function matchCourses(courses, q) {
  const s = String(q || '').trim();
  if (!s) return [];
  if (/^\d+$/.test(s)) return courses.filter((c) => c.id === s);
  const n = s.toLowerCase().replace(/\s+/g, '');
  const code = (c) => c.code.toLowerCase().replace(/\s+/g, '');
  const exact = courses.filter((c) => code(c) === n);
  if (exact.length) return exact;
  // The next character must not continue the code: MATH253 matches MATH253-202526, not MATH2530.
  const continues = /\d$/.test(n) ? /\d/ : /[a-z0-9]/i;
  return courses.filter((c) => code(c).startsWith(n) && !continues.test(code(c)[n.length] || ''));
}

// Dates in UK time with the zone that applies on that day (GMT in winter, BST in summer).
const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
export function londonTime(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : LONDON.format(d).replace(',', '');
}
