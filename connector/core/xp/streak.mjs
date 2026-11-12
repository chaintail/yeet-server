// Streak: consecutive UTC days on which the account earned any XP. Today counts once it has an event; until then the
// streak still stands on yesterday, so a person does not see it drop to 0 at midnight.
export const addDays=(day,n)=>new Date(Date.parse(`${day}T00:00:00.000Z`)+n*86_400_000).toISOString().slice(0,10);

/** Days with at least one xp_event for `who`, as a Set of 'YYYY-MM-DD'. */
export function activeDays(db,who){
 return new Set(db.prepare('SELECT DISTINCT substr(ts,1,10) d FROM xp_event WHERE identity_id=?').all(who).map(r=>r.d));
}

/** Consecutive active days ending exactly on `day` (0 if `day` itself has no event). */
export function runEndingOn(db,who,day,days=activeDays(db,who)){
 let cursor=day,n=0;
 while(days.has(cursor)){n++;cursor=addDays(cursor,-1)}
 return n;
}

/** Streak shown on `day`: the run ending today if today has an event, else the run ending yesterday. */
export function streakDays(db,who,day){
 const days=activeDays(db,who);
 return runEndingOn(db,who,days.has(day)?day:addDays(day,-1),days);
}
