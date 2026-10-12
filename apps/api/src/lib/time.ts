// Local time for the country cell. Botswana is UTC+2 all year (no DST).
const OFFSET = process.env.KGOTLA_UTC_OFFSET ?? '+02:00';
const OFFSET_MIN = (() => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(OFFSET);
  if (!m) return 120;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
})();

const WD = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], tn: ['Sontaga', 'Mosupologo', 'Labobedi', 'Laboraro', 'Labone', 'Labotlhano', 'Lamatlhatso'] };
const MON = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  tn: ['Ferikgong', 'Tlhakole', 'Mopitlo', 'Moranang', 'Motsheganong', 'Seetebosigo', 'Phukwi', 'Phatwe', 'Lwetse', 'Diphalane', 'Ngwanatsele', 'Sedimonthole'],
};

/** A Date shifted so its UTC fields read as local wall-clock time. */
const local = (d: Date) => new Date(d.getTime() + OFFSET_MIN * 60_000);

export function localDate(d = new Date()): string {
  return local(d).toISOString().slice(0, 10);
}

/** The next n working days (Mon–Fri) after today, as YYYY-MM-DD. */
export function nextWorkdays(n: number, from = new Date()): string[] {
  const out: string[] = [];
  let d = local(from);
  while (out.length < n) {
    d = new Date(d.getTime() + 86400_000);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Combine a local date and HH:MM into an absolute instant. */
export function slotInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${OFFSET}`);
}

export function dayLabel(d: Date | string, lang: 'en' | 'tn' = 'en'): string {
  const x = local(typeof d === 'string' ? new Date(d.length === 10 ? d + 'T12:00:00' + OFFSET : d) : d);
  return `${WD[lang][x.getUTCDay()]} ${x.getUTCDate()} ${MON[lang][x.getUTCMonth()]}`;
}

export function timeLabel(d: Date | string): string {
  return local(new Date(d)).toISOString().slice(11, 16);
}

export function dateLabel(d: Date | string, lang: 'en' | 'tn' = 'en'): string {
  const x = local(new Date(d));
  return `${x.getUTCDate()} ${MON[lang][x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}
