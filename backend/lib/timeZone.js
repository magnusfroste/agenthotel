// The panel's time zone setting: '' (each browser shows times where it is) or
// an IANA name such as Europe/Stockholm. Only display: the hotel's clock, its
// logs and its scheduled jobs stay on UTC.

// What is wrong with a value for the setting, or null. undefined means the
// request does not touch it.
function timeZoneProblem(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) return 'The time zone must be a zone name such as Europe/Stockholm, or empty for where you are';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return null;
  } catch (e) {
    return `"${value}" is not a time zone this server knows. Use a name such as Europe/Stockholm, or leave it empty for where you are`;
  }
}

module.exports = { timeZoneProblem };
