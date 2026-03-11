import type {
  IDateRepresentation,
  IDateTimeRepresentation,
  IDayTimeDurationRepresentation,
  IDurationRepresentation,
  ITimeRepresentation,
  ITimeZoneRepresentation,
  IYearMonthDurationRepresentation,
} from '@comunica/types';

// Copied from @comunica/utils-expression-evaluator - since the package has a lot of dependencies!

function numSerializer(num: number, min = 2): string {
  return num.toLocaleString(undefined, { minimumIntegerDigits: min, useGrouping: false });
}

export function serializeDateTime(date: IDateTimeRepresentation): string {
  // https://www.w3.org/TR/xmlschema-2/#dateTime
  // Extraction is needed because the date serializer can not add timezone y
  return `${serializeDate({ year: date.year, month: date.month, day: date.day })}T${serializeTime(date)}`;
}

function serializeTimeZone(tz: Partial<ITimeZoneRepresentation>): string {
  // https://www.w3.org/TR/xmlschema-2/#dateTime-timezones
  if (tz.zoneHours === undefined || tz.zoneMinutes === undefined) {
    return '';
  }
  if (tz.zoneHours === 0 && tz.zoneMinutes === 0) {
    return 'Z';
  }
  // SerializeTimeZone({ zoneHours: 5, zoneMinutes: 4 }) returns +05:04
  return `${tz.zoneHours >= 0 ? `+${numSerializer(tz.zoneHours)}` : numSerializer(tz.zoneHours)}:${numSerializer(Math.abs(tz.zoneMinutes))}`;
}

export function serializeDate(date: IDateRepresentation): string {
  // https://www.w3.org/TR/xmlschema-2/#date-lexical-representation
  return `${numSerializer(date.year, 4)}-${numSerializer(date.month)}-${numSerializer(date.day)}${serializeTimeZone(date)}`;
}

export function serializeTime(time: ITimeRepresentation): string {
  // https://www.w3.org/TR/xmlschema-2/#time-lexical-repr
  return `${numSerializer(time.hours)}:${numSerializer(time.minutes)}:${numSerializer(time.seconds)}${serializeTimeZone(time)}`;
}

export function toJSDate(date: IDateTimeRepresentation): Date {
  // The given hours will be assumed to be local time.
  const res = new Date(
    date.year,
    date.month - 1,
    date.day,
    date.hours,
    date.minutes,
    Math.trunc(date.seconds),
    (date.seconds % 1) * 1_000,
  );
  if (date.year >= 0 && date.year < 100) {
    // Special rule of date has gone int action:

    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/Date#individual_date_and_time_component_values

    const jumpDeltaOfDate = 1_900;
    res.setFullYear(res.getFullYear() - jumpDeltaOfDate);
  }
  return res;
}

export function defaultedDateTimeRepresentation(rep: Partial<IDateTimeRepresentation>): IDateTimeRepresentation {
  return {
    ...rep,
    day: rep.day ?? 1,
    hours: rep.hours ?? 0,
    month: rep.month ?? 1,
    year: rep.year ?? 0,
    seconds: rep.seconds ?? 0,
    minutes: rep.minutes ?? 0,
  };
}

export function toUTCDate(date: Partial<IDateTimeRepresentation>, defaultTimezone: ITimeZoneRepresentation): Date {
  const localTime = toJSDate(defaultedDateTimeRepresentation(date));
  // This date has been constructed in machine local time, now we alter it to become UTC and convert to correct timezone

  // Correction needed from local machine timezone to UTC
  const minutesCorrectionLocal = localTime.getTimezoneOffset();
  // Correction needed from UTC to provided timeZone
  const hourCorrectionUTC = date.zoneHours ?? defaultTimezone.zoneHours;
  const minutesCorrectionUTC = date.zoneMinutes ?? defaultTimezone.zoneMinutes;
  return new Date(
    localTime.getTime() - (minutesCorrectionLocal + hourCorrectionUTC * 60 + minutesCorrectionUTC) * 60 * 1_000,
  );
}

export function toDateTimeRepresentation({ date, timeZone }:
{ date: Date; timeZone: ITimeZoneRepresentation }): IDateTimeRepresentation {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
    zoneHours: timeZone.zoneHours,
    zoneMinutes: timeZone.zoneMinutes,
  };
}

export class ParseError extends Error {
  public constructor(str: string, type: string) {
    super(`Failed to parse "${str}" as ${type}.`);
  }
}

function parseTimeZone(timeZoneStr: string): Partial<ITimeZoneRepresentation> {
  // https://www.w3.org/TR/xmlschema-2/#dateTime-timezones
  if (timeZoneStr === '') {
    return { zoneHours: undefined, zoneMinutes: undefined };
  }
  if (timeZoneStr === 'Z') {
    return { zoneHours: 0, zoneMinutes: 0 };
  }
  const timeZoneStrings = timeZoneStr.replaceAll(/^([+|-])(\d\d):(\d\d)$/gu, '$11!$2!$3').split('!');
  const timeZone = timeZoneStrings.map(Number);
  return {
    zoneHours: timeZone[0] * timeZone[1],
    zoneMinutes: timeZone[0] * timeZone[2],
  };
}

export function parseDate(dateStr: string): IDateRepresentation {
  // https://www.w3.org/TR/xmlschema-2/#date-lexical-representation
  const formatted = dateStr.replaceAll(
    /^(-)?([123456789]*\d{4})-(\d\d)-(\d\d)(Z|([+-]\d\d:\d\d))?$/gu,
    '$11!$2!$3!$4!$5',
  );
  if (formatted === dateStr) {
    throw new ParseError(dateStr, 'date');
  }
  const dateStrings = formatted.split('!');
  const date = dateStrings.slice(0, -1).map(Number);

  const res = {
    year: date[0] * date[1],
    month: date[2],
    day: date[3],
    ...parseTimeZone(dateStrings[4]),
  };
  if (!(res.month >= 1 && res.month <= 12) || !(res.day >= 1 && res.day <= maximumDayInMonthFor(res.year, res.month))) {
    throw new ParseError(dateStr, 'date');
  }
  return res;
}

function __parseTime(timeStr: string): ITimeRepresentation {
  // https://www.w3.org/TR/xmlschema-2/#time-lexical-repr
  const formatted = timeStr.replaceAll(/^(\d\d):(\d\d):(\d\d(\.\d+)?)(Z|([+-]\d\d:\d\d))?$/gu, '$1!$2!$3!$5');
  if (formatted === timeStr) {
    throw new ParseError(timeStr, 'time');
  }
  const timeStrings = formatted.split('!');
  const time = timeStrings.slice(0, -1).map(Number);

  const res = {
    hours: time[0],
    minutes: time[1],
    seconds: time[2],
    ...parseTimeZone(timeStrings[3]),
  };

  if (res.seconds >= 60 || res.minutes >= 60 || res.hours > 24 ||
    (res.hours === 24 && (res.minutes !== 0 || res.seconds !== 0))) {
    throw new ParseError(timeStr, 'time');
  }
  return res;
}

export function parseDateTime(dateTimeStr: string): IDateTimeRepresentation {
  // https://www.w3.org/TR/xmlschema-2/#dateTime
  const [ date, time ] = dateTimeStr.split('T');
  if (time === undefined) {
    throw new ParseError(dateTimeStr, 'dateTime');
  }
  return { ...parseDate(date), ...__parseTime(time) };
}

export function defaultedDayTimeDurationRepresentation(rep: Partial<IDayTimeDurationRepresentation>):
IDayTimeDurationRepresentation {
  return {
    day: rep.day ?? 0,
    hours: rep.hours ?? 0,
    minutes: rep.minutes ?? 0,
    seconds: rep.seconds ?? 0,
  };
}

export function defaultedDurationRepresentation(
  rep: Partial<IDurationRepresentation>,
): IDurationRepresentation {
  return {
    ...defaultedDayTimeDurationRepresentation(rep),
    ...defaultedYearMonthDurationRepresentation(rep),
  };
}

export function defaultedYearMonthDurationRepresentation(rep: Partial<IYearMonthDurationRepresentation>):
IYearMonthDurationRepresentation {
  return {
    year: rep.year ?? 0,
    month: rep.month ?? 0,
  };
}

function fDiv(arg: number, high: number, low = 0): { intDiv: number; remainder: number } {
  // Adds the 4 spec functions into one since they are highly related,
  // and fQuotient and modulo are almost always called in pairs.
  const first = arg - low;
  const second = high - low;
  const intDiv = Math.floor(first / second);
  return { intDiv, remainder: arg - intDiv * second };
}

export function maximumDayInMonthFor(yearValue: number, monthValue: number): number {
  const { intDiv: additionalYears, remainder: month } = fDiv(monthValue, 13, 1);
  const year = yearValue + additionalYears;

  if ([ 1, 3, 5, 7, 8, 10, 12 ].includes(month)) {
    return 31;
  }
  if ([ 4, 6, 9, 11 ].includes(month)) {
    return 30;
  }
  if (month === 2 && (
    fDiv(year, 400).remainder === 0 ||
    (fDiv(year, 100).remainder !== 0 && fDiv(year, 4).remainder === 0))) {
    return 29;
  }
  return 28;
}

export function addDurationToDateTime(date: IDateTimeRepresentation, duration: IDurationRepresentation):
IDateTimeRepresentation {
  // Used to cary over optional fields like timezone
  const newDate: IDateTimeRepresentation = { ...date };

  // Month
  let tempDiv = fDiv(date.month + duration.month, 13, 1);
  newDate.month = tempDiv.remainder;
  // Year
  newDate.year = date.year + duration.year + tempDiv.intDiv;
  // Seconds
  tempDiv = fDiv(date.seconds + duration.seconds, 60);
  newDate.seconds = tempDiv.remainder;
  // Minutes
  tempDiv = fDiv(date.minutes + duration.minutes + tempDiv.intDiv, 60);
  newDate.minutes = tempDiv.remainder;
  // Hours
  tempDiv = fDiv(date.hours + duration.hours + tempDiv.intDiv, 24);
  newDate.hours = tempDiv.remainder;

  // We skip a part of the spec code since: Defined spec code can not happen since it would be an invalid literal

  newDate.day = date.day + duration.day + tempDiv.intDiv;

  while (true) {
    let carry;
    if (newDate.day < 1) {
      newDate.day += maximumDayInMonthFor(newDate.year, newDate.month - 1);
      carry = -1;
    } else if (newDate.day > maximumDayInMonthFor(newDate.year, newDate.month)) {
      newDate.day -= maximumDayInMonthFor(newDate.year, newDate.month);
      carry = 1;
    } else {
      break;
    }
    tempDiv = fDiv(newDate.month + carry, 13, 1);
    newDate.month = tempDiv.remainder;
    newDate.year += tempDiv.intDiv;
  }
  return newDate;
}
