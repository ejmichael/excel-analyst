-- Part W3: a usage kind for appending dashboard widgets to an existing report. It counts toward no plan limit, rate
-- limit or usage figure (owner_usage_month counts only upload, question, report, report_run and export). Saving to a
-- new report still writes kind 'report', which counts toward max_reports_per_month like any other report.

alter type usage_kind add value if not exists 'dashboard_save';
