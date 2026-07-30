#!/usr/bin/env python3
"""Generate 'Cairn Apple Health Sync.xml' — the Apple Shortcuts plist behind
the signed template the repo ships at public/shortcuts/.

Rebuild + re-sign (macOS, any Mac with the Shortcuts app):

    python3 scripts/apple-shortcut/build_shortcut.py
    plutil -convert binary1 "scripts/apple-shortcut/Cairn Apple Health Sync.xml" \
        -o /tmp/cairn-shortcut-unsigned.shortcut
    shortcuts sign --mode anyone --input /tmp/cairn-shortcut-unsigned.shortcut \
        --output "public/shortcuts/Cairn Apple Health Sync.shortcut"

Then validate the artifact on a real iPhone (install, pair, first sync) before
shipping — see docs/APPLE_HEALTH.md. Apple's signing certificate has an
expiry (~13 months from signing), so re-sign whenever the artifact is
refreshed or imports start being refused.

Serialization is copied from observed/verified sources, then corrected against
a real device wherever they disagreed (they did — see inline comments marked
with the version they broke):
  - shortcuts-playground skill docs (PLIST_FORMAT / VARIABLES / CONTROL_FLOW /
    FILTERS / HEALTHKIT / PARAMETER_TYPES) + its golden-shortcut XML corpus
  - pfgithub/scpl OutActions.json (Apple action metadata dump)
  - the dyld shared cache as ground truth for parameter keys:
    cd /System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld &&
    cat dyld_shared_cache_arm64e* | grep -aoc "WFSomeKey"
    (a key with 0 hits does not exist, whatever the docs say)
"""

import plistlib
import os

OBJ = "￼"  # U+FFFC object replacement char = variable placeholder

# ---------------------------------------------------------------- UUID helper
_uuid_n = 0
_uuids = {}


def U(name: str) -> str:
    """Stable uppercase UUID per logical action name."""
    global _uuid_n
    if name not in _uuids:
        _uuid_n += 1
        _uuids[name] = "CA12N000-0000-4000-8000-{:012X}".format(_uuid_n)
    return _uuids[name]


# ------------------------------------------------------- value/token builders
def out(name: str, uuid: str, aggr=None) -> dict:
    """An ActionOutput reference dict (the inner `Value`)."""
    d = {"OutputName": name, "OutputUUID": uuid, "Type": "ActionOutput"}
    if aggr:
        d["Aggrandizements"] = aggr
    return d


def varref(name: str) -> dict:
    return {"Type": "Variable", "VariableName": name}


def att(value: dict) -> dict:
    """WFTextTokenAttachment wrapper — non-display data-flow parameters."""
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def ts(*parts) -> dict:
    """WFTextTokenString: literal strings + attachment dicts interleaved.

    Positions in attachmentsByRange are computed from the final string so a
    copy/paste offset error is impossible.
    """
    s = ""
    ranges = {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            ranges["{%d, 1}" % len(s)] = p
            s += OBJ
    return {
        "Value": {"attachmentsByRange": ranges, "string": s},
        "WFSerializationType": "WFTextTokenString",
    }


def cond_input(value: dict) -> dict:
    """Conditional WFInput must be the Type=Variable wrapper."""
    return {"Type": "Variable", "Variable": att(value)}


def dfv(items) -> dict:
    """WFDictionaryFieldValue wrapper (headers / JSON body / Dictionary)."""
    return {
        "Value": {"WFDictionaryFieldValueItems": items},
        "WFSerializationType": "WFDictionaryFieldValue",
    }


# WFItemType -> required WFValue state class.
#
# CAUTION: the widely-circulated table (0=Text, 1=Number, 2=Array, 3=Dictionary,
# 4=Boolean) has 1 and 3 SWAPPED. The mapping below was derived empirically by
# walking every WFItemType/WFValue pair in the 19-shortcut golden export corpus:
#
#   0 -> WFTextTokenString          (Text)      38 occurrences
#   1 -> WFDictionaryFieldValue     (Dictionary) 4 occurrences
#   2 -> WFArrayParameterState      (Array)      1 occurrence
#   3 -> WFTextTokenString          (Number)    12 occurrences
#   4 -> WFNumberSubstitutableState (Boolean)    3 occurrences
#
# Declaring type 1 while supplying a WFTextTokenString makes Shortcuts throw
# "State for WFPropertyListParameterValue is not of the expected class"
# (WFPropertyListParameterValue.m:108) and crash on render.
ITEM_TYPE_STATE = {
    0: {"WFTextTokenString"},
    1: {"WFDictionaryFieldValue"},
    2: {"WFArrayParameterState"},
    3: {"WFTextTokenString"},
    4: {"WFNumberSubstitutableState"},
}


def kv(key: str, value: dict, item_type: int = 0) -> dict:
    got = value.get("WFSerializationType")
    allowed = ITEM_TYPE_STATE[item_type]
    if got not in allowed:
        raise AssertionError(
            "WFItemType %d requires %s, got %r for key %r"
            % (item_type, "/".join(sorted(allowed)), got, key)
        )
    return {"WFItemType": item_type, "WFKey": ts(key), "WFValue": value}


def qty(magnitude: str, unit: str) -> dict:
    return {
        "Value": {"Magnitude": magnitude, "Unit": unit},
        "WFSerializationType": "WFQuantityFieldValue",
    }


# ------------------------------------------------------------------- actions
ACTIONS = []


def A(identifier: str, **params) -> dict:
    a = {
        "WFWorkflowActionIdentifier": identifier,
        "WFWorkflowActionParameters": params,
    }
    ACTIONS.append(a)
    return a


def comment(text: str):
    A("is.workflow.actions.comment", WFCommentActionText=text)


def count_chars(key: str, src_key: str, src_name: str = "Text"):
    """Count Characters of a Text output -> a real number for a numeric If.

    A Text action ALWAYS produces an item, even when its content is empty, so
    condition 100 ("has any value") is TRUE for empty text and cannot be used to
    detect a missing value. Counting characters and comparing numerically is
    unambiguous. Output name is "Count".
    """
    ref = out(src_name, U(src_key))
    A(
        "is.workflow.actions.count",
        UUID=U(key),
        WFCountType="Characters",
        WFInput=att(ref),
        Input=att(ref),
    )


def if_count(group_key: str, count_key: str, gt_zero: bool):
    """If on a Count output. gt_zero=True -> '> 0'; False -> '< 1'."""
    A(
        "is.workflow.actions.conditional",
        GroupingIdentifier=U(group_key),
        WFControlFlowMode=0,
        WFCondition=2 if gt_zero else 0,  # 2 = is greater than, 0 = is less than
        WFNumberValue="0" if gt_zero else "1",
        WFInput=cond_input(out("Count", U(count_key))),
    )


def url_action(key: str, name: str, *parts):
    """A URL action feeding Get Contents of URL.

    Get Contents of URL needs an NSURL. A Text action outputs NSString, which iOS
    reports as "couldn't convert from Rich Text to URL". The URL action outputs a
    real NSURL, and 6 of 6 golden downloadurl actions in the corpus are preceded
    by one.
    """
    A(
        "is.workflow.actions.url",
        UUID=U(key),
        CustomOutputName=name,
        WFURLActionURL=ts(*parts),
    )


# =============================================================================
# Metadata comments (required by the authoring conventions)
# =============================================================================
comment(
    "Cairn Apple Health Sync\n"
    "\n"
    "Sends yesterday's Apple Health summary - steps, sleep, resting heart rate, "
    "active calories and walking + running distance - to a self-hosted Cairn "
    "instance.\n"
    "\n"
    "Run it with the pairing text from Cairn (Settings > Sources > Apple Health "
    "> Connect & test) once. The shortcut trades that one-time code for its own "
    "ingest credential and saves it to iCloud Drive. After that it runs with no "
    "input at all - by tapping it or from a Time of Day automation.\n"
    "\n"
    "These five readings were chosen because a phone alone, or a phone paired "
    "with any common wearable, actually records them. Apple-Watch-only readings "
    "are deliberately left out: on a phone that never receives them, Health "
    "interrupts every single run with a No Samples Found alert."
)
comment(
    "How to set this up - two steps, in this order\n"
    "\n"
    "1. In Cairn open Settings > Sources > Apple Health and tap Connect & test. "
    "This shortcut starts, pairs, saves its credential and stops. Approve the "
    "network prompt for your Cairn address and the iCloud Drive save prompt.\n"
    "\n"
    "2. Open the Shortcuts app and tap this shortcut once. Health asks for each "
    "reading it uses, one prompt at a time - tap Always Allow on each. This "
    "step has to happen inside the Shortcuts app, because Health cannot show "
    "those prompts when a shortcut is started from another app.\n"
    "\n"
    "3. Optional: create a Time of Day personal automation that runs this "
    "shortcut every morning with no input. Once the readings are approved it "
    "runs silently.\n"
    "\n"
    "The saved credential lives only in a file in iCloud Drive/Shortcuts/Cairn. "
    "It is only ever sent as an Authorization header, never inside a URL or a "
    "notification. Revoke it any time from Cairn's Settings screen."
)

# =============================================================================
# SECTION A - input handling and pairing
# =============================================================================
comment("--- READ THE LAUNCH INPUT ---")

A(
    "is.workflow.actions.detect.dictionary",
    UUID=U("in_dict"),
    WFInput=att({"Type": "ExtensionInput"}),
)
A(
    "is.workflow.actions.getvalueforkey",
    UUID=U("in_code"),
    WFDictionaryKey="pairing_code",
    WFGetDictionaryValueType="Value",
    WFInput=att(out("Dictionary", U("in_dict"))),
)
A(
    "is.workflow.actions.gettext",
    UUID=U("code_text"),
    WFTextActionText=ts(out("Dictionary Value", U("in_code"))),
)

count_chars("code_len", "code_text")

comment(
    "Decide whether this run is a pairing run or a normal sync.\n"
    "- Condition checks how many characters the launch input's code has\n"
    "- One or more means Cairn launched this with a pairing code\n"
    "- None means a plain tap or an automation, so read the saved credential"
)

if_count("g_pair", "code_len", gt_zero=True)

# ---------------------------------------------------------- pairing branch ---
comment(
    "--- PAIRING: trade the one-time code for an ingest credential ---\n"
    "- Address comes from the base_url field of the launch input\n"
    "- The request carries only the pairing code, a device label and a version"
)

A(
    "is.workflow.actions.getvalueforkey",
    UUID=U("in_base"),
    WFDictionaryKey="base_url",
    WFGetDictionaryValueType="Value",
    WFInput=att(out("Dictionary", U("in_dict"))),
)
A(
    "is.workflow.actions.gettext",
    UUID=U("base_text_a"),
    WFTextActionText=ts(out("Dictionary Value", U("in_base"))),
)
count_chars("base_len_a", "base_text_a")

comment(
    "Stop if the link did not carry a Cairn address.\n"
    "- Condition checks whether the address came through empty\n"
    "- Without it there is nothing to send the pairing code to"
)
if_count("g_nobase", "base_len_a", gt_zero=False)
A(
    "is.workflow.actions.notification",
    UUID=U("n_nobase"),
    WFNotificationActionTitle=ts("Cairn"),
    WFNotificationActionBody=ts(
        "Cairn couldn't read your instance address — start Connect & test again."
    ),
)
A("is.workflow.actions.exit")
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_nobase"),
    WFControlFlowMode=2,
)

url_action(
    "exch_url",
    "Pairing URL",
    out("Text", U("base_text_a")),
    "/api/apple-health/pairing/exchange",
)
A(
    "is.workflow.actions.downloadurl",
    UUID=U("exch"),
    Advanced=True,
    ShowHeaders=False,
    WFHTTPMethod="POST",
    WFHTTPBodyType="JSON",
    WFURL=ts(out("Pairing URL", U("exch_url"))),
    WFHTTPHeaders=dfv([]),
    WFFormValues=dfv([]),
    WFJSONValues=dfv(
        [
            kv("pairing_code", ts(out("Text", U("code_text")))),
            kv("label", ts("iPhone Shortcut")),
            kv("shortcut_version", ts("1.0.0")),
        ]
    ),
)
A(
    "is.workflow.actions.detect.dictionary",
    UUID=U("exch_dict"),
    WFInput=att(out("Contents of URL", U("exch"))),
)
A(
    "is.workflow.actions.getvalueforkey",
    UUID=U("exch_token"),
    WFDictionaryKey="ingest_token",
    WFGetDictionaryValueType="Value",
    WFInput=att(out("Dictionary", U("exch_dict"))),
)
A(
    "is.workflow.actions.gettext",
    UUID=U("token_text_a"),
    WFTextActionText=ts(out("Dictionary Value", U("exch_token"))),
)

count_chars("token_len", "token_text_a")

comment(
    "Stop early if pairing did not return a credential.\n"
    "- Condition checks whether the credential came back empty\n"
    "- Pairing codes are single use and expire after ten minutes"
)
if_count("g_tokfail", "token_len", gt_zero=False)
A(
    "is.workflow.actions.notification",
    UUID=U("n_pairfail"),
    WFNotificationActionTitle=ts("Cairn"),
    WFNotificationActionBody=ts(
        "Cairn pairing failed — get a fresh code in Cairn Settings and try again."
    ),
)
A("is.workflow.actions.exit")
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_tokfail"),
    WFControlFlowMode=2,
)

comment(
    "--- PAIRING: remember the credential, then stop ---\n"
    "Saved to iCloud Drive as Shortcuts/Cairn/cairn-sync-config.txt so a bare "
    "run or a Time of Day automation can sync without any input. The extension "
    "is .txt on purpose: Save File names a plain-text item with the text "
    "content type's own extension, so a .json destination path is silently "
    "written out as .txt - verified on-device. Both sides use .txt so they "
    "always agree.\n"
    "\n"
    "Pairing deliberately stops here rather than syncing straight away. Cairn "
    "started this run from a link, and Health cannot show its permission "
    "prompts in that situation - it just fails. The next run, started by hand "
    "from the Shortcuts app, can show them."
)
A(
    "is.workflow.actions.gettext",
    UUID=U("cfg_text"),
    WFTextActionText=ts(
        '{"base_url": "',
        out("Text", U("base_text_a")),
        '", "ingest_token": "',
        out("Text", U("token_text_a")),
        '"}',
    ),
)
A(
    "is.workflow.actions.documentpicker.save",
    UUID=U("save_cfg"),
    WFInput=att(out("Text", U("cfg_text"))),
    WFFileStorageService="iCloud Drive",
    WFAskWhereToSave=False,
    WFFileDestinationPath="Cairn/cairn-sync-config.txt",
    WFSaveFileOverwrite=True,
)
A(
    "is.workflow.actions.notification",
    UUID=U("n_paired"),
    WFNotificationActionTitle=ts("Cairn"),
    WFNotificationActionBody=ts(
        "Cairn paired ✓. Now open Shortcuts and tap Cairn Apple Health Sync "
        "once to grant Health access and run the first sync."
    ),
)
A("is.workflow.actions.exit")

# -------------------------------------------------------- normal-run branch --
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_pair"),
    WFControlFlowMode=1,
)

comment(
    "--- NORMAL RUN: reuse the saved credential ---\n"
    "- Get File reads the saved settings file without showing a picker\n"
    "- Error If Not Found is off so a first run before pairing just continues"
)
A(
    "is.workflow.actions.documentpicker.open",
    UUID=U("get_cfg"),
    WFFileStorageService="iCloud Drive",
    WFShowFilePicker=False,
    WFGetFilePath="Cairn/cairn-sync-config.txt",
    WFFileErrorIfNotFound=False,
)
A(
    "is.workflow.actions.detect.dictionary",
    UUID=U("cfg_dict"),
    WFInput=att(out("File", U("get_cfg"))),
)
A(
    "is.workflow.actions.getvalueforkey",
    UUID=U("cfg_base"),
    WFDictionaryKey="base_url",
    WFGetDictionaryValueType="Value",
    WFInput=att(out("Dictionary", U("cfg_dict"))),
)
A(
    "is.workflow.actions.gettext",
    UUID=U("base_text_b"),
    WFTextActionText=ts(out("Dictionary Value", U("cfg_base"))),
)
A(
    "is.workflow.actions.getvalueforkey",
    UUID=U("cfg_token"),
    WFDictionaryKey="ingest_token",
    WFGetDictionaryValueType="Value",
    WFInput=att(out("Dictionary", U("cfg_dict"))),
)
A(
    "is.workflow.actions.gettext",
    UUID=U("token_text_b"),
    WFTextActionText=ts(out("Dictionary Value", U("cfg_token"))),
)

count_chars("cfg_len", "base_text_b")

comment(
    "Stop if this phone has never been paired.\n"
    "- Condition checks whether the saved address has any characters\n"
    "- A first run before pairing finds no settings file and stops quietly here"
)
if_count("g_nocfg", "cfg_len", gt_zero=False)
A(
    "is.workflow.actions.notification",
    UUID=U("n_nopair"),
    WFNotificationActionTitle=ts("Cairn"),
    WFNotificationActionBody=ts(
        "Not paired yet. In Cairn: Settings → Sources → Apple Health "
        "→ Connect & test."
    ),
)
A("is.workflow.actions.exit")
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_nocfg"),
    WFControlFlowMode=2,
)

A(
    "is.workflow.actions.setvariable",
    WFVariableName="Cairn Base URL",
    WFInput=att(out("Text", U("base_text_b"))),
)
A(
    "is.workflow.actions.setvariable",
    WFVariableName="Cairn Token",
    WFInput=att(out("Text", U("token_text_b"))),
)

A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_pair"),
    WFControlFlowMode=2,
)

# =============================================================================
# SECTION B - the day being summarised
# =============================================================================
comment(
    "--- WORK OUT YESTERDAY, THE LAST COMPLETE DAY ---\n"
    "- Date is the current date; Adjust Date steps back one day\n"
    "- Format Date turns it into the plain yyyy-MM-dd the server expects\n"
    "- Yesterday Start and Today Start bound every Health search below"
)

A("is.workflow.actions.date", UUID=U("now"), WFDateActionMode="Current Date")
A(
    "is.workflow.actions.adjustdate",
    UUID=U("yday"),
    CustomOutputName="Yesterday",
    WFDate=ts(out("Date", U("now"))),
    WFAdjustOperation="Subtract",
    WFDuration=qty("1", "days"),
)
A(
    "is.workflow.actions.format.date",
    UUID=U("datestr"),
    WFDate=ts(out("Yesterday", U("yday"))),
    # WFDateFormatStyle selects custom mode; WFDateFormat holds the ICU pattern.
    # (WFDateFormatString does NOT exist — 0 hits in the dyld cache. v5 set
    # WFDateFormat="Custom", so the device formatted with the literal pattern
    # "Custom", the server rejected the garbage date, and every sync failed.)
    WFDateFormatStyle="Custom",
    WFDateFormat="yyyy-MM-dd",
)
A(
    "is.workflow.actions.date",
    UUID=U("ystart"),
    CustomOutputName="Yesterday Start",
    WFDateActionMode="Specified Date",
    WFDateActionDate=ts(out("Formatted Date", U("datestr")), " 00:00"),
)
A(
    "is.workflow.actions.adjustdate",
    UUID=U("tstart"),
    CustomOutputName="Today Start",
    WFDate=ts(out("Yesterday Start", U("ystart"))),
    WFAdjustOperation="Add",
    WFDuration=qty("1", "days"),
)
A(
    "is.workflow.actions.adjustdate",
    UUID=U("slp_from"),
    CustomOutputName="Sleep Window Start",
    WFDate=ts(out("Yesterday Start", U("ystart"))),
    WFAdjustOperation="Subtract",
    WFDuration=qty("6", "hr"),
)
A(
    "is.workflow.actions.adjustdate",
    UUID=U("slp_to"),
    CustomOutputName="Sleep Window End",
    WFDate=ts(out("Yesterday Start", U("ystart"))),
    WFAdjustOperation="Add",
    WFDuration=qty("18", "hr"),
)

# =============================================================================
# SECTION C - health reads (one action per data type, grant-minimal)
# =============================================================================


def health_filter(sample_label: str, from_uuid: str, from_name: str,
                  to_uuid: str, to_name: str) -> dict:
    """WFContentItemFilter for Find Health Samples.

    Row 1: the locked `Type is <picker label>` enumeration row.
    Row 2: `Start Date is between <from> and <to>` (date operator 1003).
    """
    return {
        "Value": {
            "WFActionParameterFilterPrefix": 1,  # All are true
            "WFContentPredicateBoundedDate": False,
            "WFActionParameterFilterTemplates": [
                {
                    "Bounded": True,
                    "Operator": 4,
                    "Property": "Type",
                    "Removable": False,
                    "Values": {
                        "Enumeration": {
                            "Value": sample_label,
                            "WFSerializationType": "WFStringSubstitutableState",
                        }
                    },
                },
                {
                    "Bounded": True,
                    "Operator": 1003,
                    "Property": "Start Date",
                    "Removable": False,
                    "Values": {
                        "Date": att(out(from_name, from_uuid)),
                        "AnotherDate": att(out(to_name, to_uuid)),
                    },
                },
            ],
        },
        "WFSerializationType": "WFContentPredicateTableTemplate",
    }


def find_samples(key: str, label: str, from_uuid=None, from_name=None,
                 to_uuid=None, to_name=None):
    from_uuid = from_uuid or U("ystart")
    from_name = from_name or "Yesterday Start"
    to_uuid = to_uuid or U("tstart")
    to_name = to_name or "Today Start"
    A(
        "is.workflow.actions.filter.health.quantity",
        UUID=U(key),
        WFContentItemFilter=health_filter(
            label, from_uuid, from_name, to_uuid, to_name
        ),
    )


def statistics(key: str, src_key: str, operation: str, src_name="Health Samples"):
    A(
        "is.workflow.actions.statistics",
        UUID=U(key),
        WFStatisticsOperation=operation,
        Input=att(out(src_name, U(src_key))),
    )


comment(
    "--- READ YESTERDAY'S HEALTH SAMPLES ---\n"
    "Each reading gets its own Find Health Samples action so Health only asks "
    "for what this shortcut actually uses. Calculate Statistics reduces each "
    "set of samples to the single number Cairn stores.\n"
    "\n"
    "Only readings a phone or a common wearable really records are included. "
    "Heart Rate Variability SDNN and Exercise Minutes were removed on purpose: "
    "Exercise Minutes is written by Apple Watch alone, and other trackers do "
    "not write HRV in the SDNN form Health stores. On a phone that never "
    "receives one of these, Find Health Samples stops the run with a No "
    "Samples Found alert that has to be dismissed by hand - which would break "
    "an unattended morning automation. Cairn treats missing readings normally, "
    "and its own wearable integrations already cover recovery."
)

find_samples("f_steps", "Steps")
statistics("s_steps", "f_steps", "Sum")

find_samples("f_rhr", "Resting Heart Rate")
statistics("s_rhr", "f_rhr", "Average")

find_samples("f_cal", "Active Calories")
statistics("s_cal", "f_cal", "Sum")

find_samples("f_dist", "Walking + Running Distance")
statistics("s_dist", "f_dist", "Sum")

comment(
    "--- READ THE NIGHT THAT ENDED YESTERDAY MORNING ---\n"
    "Sleep runs from the evening before, so it uses its own window: the "
    "evening two days back through yesterday early evening. Get Details of "
    "Health Sample returns each stretch of sleep as a duration in seconds, so "
    "the total is divided by 60 to report minutes.\n"
    "ALLOW_MANUAL_UNIT_CONVERSION: Convert Measurement cannot take a Health "
    "sleep duration, so seconds to minutes is done with plain division."
)
find_samples(
    "f_sleep",
    "Sleep",
    from_uuid=U("slp_from"),
    from_name="Sleep Window Start",
    to_uuid=U("slp_to"),
    to_name="Sleep Window End",
)
A(
    "is.workflow.actions.properties.health.quantity",
    UUID=U("sleep_dur"),
    WFContentItemPropertyName="Duration",
    WFInput=att(out("Health Samples", U("f_sleep"))),
)
statistics("s_sleep", "sleep_dur", "Sum", src_name="Duration")
A(
    "is.workflow.actions.math",
    UUID=U("sleep_min"),
    WFInput=att(out("Statistics", U("s_sleep"))),
    WFMathOperation="÷",  # U+00F7 DIVISION SIGN - never ASCII '/'
    WFMathOperand="60",
)

# =============================================================================
# SECTION D - send the summary
# =============================================================================
comment(
    "--- SEND THE SUMMARY TO CAIRN ---\n"
    "- Address is the saved Cairn address plus the metrics path\n"
    "- The credential travels only in the Authorization header\n"
    "- Cairn stores one row per day, so re-running is safe"
)

url_action(
    "post_url", "Metrics URL", varref("Cairn Base URL"), "/api/health-metrics"
)
A(
    "is.workflow.actions.downloadurl",
    UUID=U("post"),
    Advanced=True,
    ShowHeaders=False,
    WFHTTPMethod="POST",
    WFHTTPBodyType="JSON",
    WFURL=ts(out("Metrics URL", U("post_url"))),
    WFHTTPHeaders=dfv(
        [kv("Authorization", ts("Bearer ", varref("Cairn Token")))]
    ),
    WFFormValues=dfv([]),
    WFJSONValues=dfv(
        [
            # Every row is a text item (WFItemType 0), the only shape the golden
            # corpus ever uses inside WFJSONValues. The metrics therefore go over
            # the wire as JSON strings; recordDailyMetrics' `num()` coercion
            # (src/repo/coach.ts) turns "8200" into 8200 and — better than a
            # number item would — turns an absent metric's "" into null rather
            # than a misleading 0.
            kv("source", ts("apple_health")),
            kv("date", ts(out("Formatted Date", U("datestr")))),
            kv("steps", ts(out("Statistics", U("s_steps")))),
            kv("sleep_min", ts(out("Calculation Result", U("sleep_min")))),
            kv("resting_hr", ts(out("Statistics", U("s_rhr")))),
            kv("active_calories", ts(out("Statistics", U("s_cal")))),
            kv("distance_km", ts(out("Statistics", U("s_dist")))),
        ]
    ),
)
A(
    "is.workflow.actions.detect.dictionary",
    UUID=U("resp_dict"),
    WFInput=att(out("Contents of URL", U("post"))),
)
A(
    "is.workflow.actions.getvalueforkey",
    UUID=U("resp_ok"),
    # `saved` is a JSON NUMBER (rows written; always 1 on success here), so its
    # text form is unambiguous ("1"). The `ok` flag is a JSON boolean, and how
    # Shortcuts stringifies a boolean is exactly the kind of undocumented
    # coercion this build no longer relies on.
    WFDictionaryKey="saved",
    WFGetDictionaryValueType="Value",
    WFInput=att(out("Dictionary", U("resp_dict"))),
)
A(
    "is.workflow.actions.gettext",
    UUID=U("ok_text"),
    WFTextActionText=ts(out("Dictionary Value", U("resp_ok"))),
)

comment(
    "Tell the user how it went.\n"
    "- Condition checks how many day-rows Cairn saved (this Shortcut sends 1)\n"
    "- Anything else means Cairn refused the payload"
)
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_ok"),
    WFControlFlowMode=0,
    WFCondition=4,  # is (string equals)
    WFConditionalActionString="1",
    WFInput=cond_input(out("Text", U("ok_text"))),
)
A(
    "is.workflow.actions.notification",
    UUID=U("n_ok"),
    WFNotificationActionTitle=ts("Cairn"),
    WFNotificationActionBody=ts(
        "Cairn updated for ", out("Formatted Date", U("datestr"))
    ),
)
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_ok"),
    WFControlFlowMode=1,
)
A(
    "is.workflow.actions.notification",
    UUID=U("n_fail"),
    WFNotificationActionTitle=ts("Cairn"),
    WFNotificationActionBody=ts(
        "Cairn sync failed — open Cairn to check Sources."
    ),
)
A(
    "is.workflow.actions.conditional",
    GroupingIdentifier=U("g_ok"),
    WFControlFlowMode=2,
)

# =============================================================================
# Workflow root
# =============================================================================
WORKFLOW = {
    "WFWorkflowActions": ACTIONS,
    "WFWorkflowClientVersion": "2700.0.4",
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowIcon": {
        "WFWorkflowIconGlyphNumber": 59754,   # heart
        "WFWorkflowIconStartColor": 431817727,  # Teal #57CFB4
    },
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": [
        "WFStringContentItem",
        "WFRichTextContentItem",
        "WFURLContentItem",
    ],
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowName": "Cairn Apple Health Sync",
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowTypes": [],
}

HERE = os.path.dirname(os.path.abspath(__file__))
target = os.path.join(HERE, "Cairn Apple Health Sync.xml")
with open(target, "wb") as fh:
    plistlib.dump(WORKFLOW, fh, fmt=plistlib.FMT_XML, sort_keys=True)

print("wrote %s (%d actions)" % (target, len(ACTIONS)))
