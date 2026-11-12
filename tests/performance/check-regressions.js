#!/usr/bin/env node

/*
 * Compares the performance results of this change with the ones of its target
 * and reports every metric that got worse by more than its budget allows.
 *
 * Usage: node check-regressions.js [summary-file]
 *
 * Environment variables:
 * - PERFORMANCE_REGRESSION_MODE: `fail` exits with code 1 when a metric with the
 *   `error` severity regressed. Any other value only reports. Defaults to `report`.
 * - PERFORMANCE_REGRESSION_ACCEPTED: `true` reports regressions without failing,
 *   for changes whose cost has been reviewed and accepted.
 */

/**
 * External dependencies.
 */
const { writeFileSync } = require( 'node:fs' );
const { join } = require( 'node:path' );

/**
 * Internal dependencies
 */
const {
	median,
	medianAbsoluteDeviation,
	accumulateValues,
	formatAsMarkdownTable,
	formatValue,
	parseFile,
} = require( './utils' );

const summaryFile = process.argv[ 2 ];
const failOnError = process.env.PERFORMANCE_REGRESSION_MODE === 'fail';
const regressionAccepted =
	process.env.PERFORMANCE_REGRESSION_ACCEPTED === 'true';

/**
 * A metric regresses when its median grows by more than `minAbsolute` and by
 * more than `minRelative` of the target's median. Timing metrics must also grow
 * by more than `noiseFactor` times the combined spread of both samples.
 *
 * Asset counts and sizes, database queries and memory are deterministic for a
 * given build, so a regression there is real and fails the check. Timings carry
 * CI noise, so they are reported as warnings.
 *
 * @type {Record<string, {minAbsolute: number, minRelative: number, noiseFactor?: number, severity: 'error'|'warning'}>}
 */
const budgets = {
	scriptCount: { minAbsolute: 2, minRelative: 0.05, severity: 'error' },
	scriptTransferSize: {
		minAbsolute: 20 * 1024,
		minRelative: 0.02,
		severity: 'error',
	},
	stylesheetCount: { minAbsolute: 2, minRelative: 0.05, severity: 'error' },
	stylesheetTransferSize: {
		minAbsolute: 10 * 1024,
		minRelative: 0.02,
		severity: 'error',
	},
	wpDbQueries: { minAbsolute: 2, minRelative: 0.05, severity: 'error' },
	wpMemoryUsage: {
		minAbsolute: 1024 * 1024,
		minRelative: 0.05,
		severity: 'error',
	},
	domContentLoaded: {
		minAbsolute: 10,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
	domContentLoadedMinusTtfb: {
		minAbsolute: 10,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
	load: {
		minAbsolute: 10,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
	largestContentfulPaint: {
		minAbsolute: 10,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
	lcpMinusTtfb: {
		minAbsolute: 10,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
	timeToFirstByte: {
		minAbsolute: 5,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
	wpTotal: {
		minAbsolute: 5,
		minRelative: 0.1,
		noiseFactor: 3,
		severity: 'warning',
	},
};

/**
 * Scales the median absolute deviation to estimate the standard deviation of
 * normally distributed values without being skewed by outliers.
 */
const MAD_TO_STANDARD_DEVIATION = 1.4826;

/**
 * Returns the combined noise of two samples of the same metric.
 *
 * @param {number[]} before Values of the target.
 * @param {number[]} after  Values of this change.
 * @return {number} Combined robust standard deviation.
 */
function combinedNoise( before, after ) {
	return (
		MAD_TO_STANDARD_DEVIATION *
		Math.hypot(
			medianAbsoluteDeviation( before ),
			medianAbsoluteDeviation( after )
		)
	);
}

/**
 * Returns the comparison of one metric against its budget.
 *
 * @param {string}   metric Metric name.
 * @param {number[]} before Values of the target.
 * @param {number[]} after  Values of this change.
 * @return {{metric: string, before: number, after: number, delta: number, relative: number, noise: number, regressed: boolean, severity: string}} Comparison.
 */
function compareMetricToBudget( metric, before, after ) {
	const budget = budgets[ metric ];
	const beforeMedian = median( before );
	const afterMedian = median( after );
	const delta = afterMedian - beforeMedian;
	const relative = beforeMedian > 0 ? delta / beforeMedian : 0;
	const noise = budget.noiseFactor ? combinedNoise( before, after ) : 0;

	const regressed =
		delta > budget.minAbsolute &&
		relative > budget.minRelative &&
		delta > ( budget.noiseFactor ?? 0 ) * noise;

	return {
		metric,
		before: beforeMedian,
		after: afterMedian,
		delta,
		relative,
		noise,
		regressed,
		severity: budget.severity,
	};
}

/**
 * Returns the budget comparisons of every scenario measured on both sides.
 *
 * @param {Array<{title: string, results: Record<string, number[]>[]}>} beforeStats Results of the target.
 * @param {Array<{title: string, results: Record<string, number[]>[]}>} afterStats  Results of this change.
 * @return {Array<{title: string, comparisons: ReturnType<typeof compareMetricToBudget>[]}>} Comparisons.
 */
function compareScenariosToBudgets( beforeStats, afterStats ) {
	const scenarios = [];

	for ( const { title, results } of afterStats ) {
		const beforeStat = beforeStats.find( ( stat ) => stat.title === title );
		if ( ! beforeStat ) {
			continue;
		}

		const afterValues = accumulateValues( results );
		const beforeValues = accumulateValues( beforeStat.results );

		const comparisons = Object.keys( budgets )
			.filter(
				( metric ) =>
					afterValues[ metric ]?.length &&
					beforeValues[ metric ]?.length
			)
			.map( ( metric ) =>
				compareMetricToBudget(
					metric,
					beforeValues[ metric ],
					afterValues[ metric ]
				)
			);

		scenarios.push( { title, comparisons } );
	}

	return scenarios;
}

/**
 * Formats the regressions as a Markdown table.
 *
 * @param {Array<{title: string} & ReturnType<typeof compareMetricToBudget>>} regressions Regressions.
 * @return {string} Markdown table.
 */
function formatRegressionsAsMarkdownTable( regressions ) {
	return formatAsMarkdownTable(
		regressions.map( ( regression ) => ( {
			Scenario: regression.title,
			Metric: regression.metric,
			Before: formatValue( regression.metric, regression.before ),
			After: formatValue( regression.metric, regression.after ),
			Change: `+${ formatValue(
				regression.metric,
				regression.delta
			) } (+${ ( regression.relative * 100 ).toFixed( 1 ) } %)`,
			Severity: regression.severity,
		} ) )
	);
}

/**
 * Checks this change against one reference and reports its regressions.
 *
 * @param {Object}  reference
 * @param {string}  reference.file        Results file of the reference.
 * @param {string}  reference.heading     Heading of the report section.
 * @param {string}  reference.missingNote Note shown when there are no reference results.
 * @param {boolean} reference.enforced    Whether error regressions may fail the check.
 * @param {Array<{title: string, results: Record<string, number[]>[]}>} afterStats Results of this change.
 * @return {{markdown: string, regressions: Array, scenarios: Array, failed: boolean}} Report.
 */
function checkAgainstReference( reference, afterStats ) {
	const referenceStats = parseFile( reference.file );
	let markdown = `### ${ reference.heading }\n\n`;

	if ( ! referenceStats.length || ! afterStats.length ) {
		return {
			markdown: `${ markdown }${ reference.missingNote }\n\n`,
			regressions: [],
			scenarios: [],
			failed: false,
		};
	}

	const scenarios = compareScenariosToBudgets( referenceStats, afterStats );
	const regressions = scenarios.flatMap( ( { title, comparisons } ) =>
		comparisons
			.filter( ( comparison ) => comparison.regressed )
			.map( ( comparison ) => ( { title, ...comparison } ) )
	);
	const errors = regressions.filter(
		( regression ) => regression.severity === 'error'
	);

	for ( const regression of regressions ) {
		const level =
			reference.enforced &&
			! regressionAccepted &&
			regression.severity === 'error'
				? 'error'
				: 'warning';
		console.log(
			`::${ level } title=Performance regression (${
				reference.heading
			})::${ regression.title }: ${
				regression.metric
			} went from ${ formatValue(
				regression.metric,
				regression.before
			) } to ${ formatValue(
				regression.metric,
				regression.after
			) } (+${ ( regression.relative * 100 ).toFixed( 1 ) } %).`
		);
	}

	if ( ! regressions.length ) {
		markdown +=
			':white_check_mark: No metric got worse by more than its budget allows.\n\n';
	} else {
		markdown += `:${ errors.length ? 'x' : 'warning' }: ${
			regressions.length
		} ${
			regressions.length === 1 ? 'metric' : 'metrics'
		} got worse by more than the budget allows.\n\n`;
		markdown += `${ formatRegressionsAsMarkdownTable( regressions ) }\n`;
	}

	const failed = reference.enforced && errors.length > 0;

	if ( failed && regressionAccepted ) {
		markdown +=
			'This change is marked as an accepted performance regression, so the check does not fail.\n\n';
	}

	return {
		markdown,
		regressions,
		scenarios,
		failed: failed && ! regressionAccepted,
	};
}

const afterStats = parseFile( 'performance-results.json' );

const targetReport = checkAgainstReference(
	{
		file: 'before-performance-results.json',
		heading: 'Compared with the target commit',
		missingNote:
			'No build of the target commit was available, so this change could not be compared with it.',
		enforced: failOnError,
	},
	afterStats
);

const releaseReport = checkAgainstReference(
	{
		file: 'base-performance-results.json',
		heading: `Compared with the last release${
			process.env.BASE_TAG ? ` (${ process.env.BASE_TAG })` : ''
		}`,
		missingNote: 'The last release was not measured in this run.',
		enforced: false,
	},
	afterStats
);

const summaryMarkdown =
	'## Performance Budget Check\n\n' +
	targetReport.markdown +
	releaseReport.markdown +
	'Asset counts and sizes, database queries and memory usage are deterministic for a build, so exceeding their budget fails pull requests. ' +
	'Timings are reported as warnings, because shared CI runners add noise.\n';

writeFileSync(
	join( process.env.WP_ARTIFACTS_PATH, 'performance-regressions.json' ),
	JSON.stringify(
		{ target: targetReport, release: releaseReport },
		( key, value ) => ( key === 'markdown' ? undefined : value ),
		2
	)
);

if ( summaryFile ) {
	writeFileSync( summaryFile, summaryMarkdown );
}

console.log( summaryMarkdown );

process.exitCode = targetReport.failed ? 1 : 0;
