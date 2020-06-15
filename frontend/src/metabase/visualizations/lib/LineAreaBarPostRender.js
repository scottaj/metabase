/* @flow weak */

import d3 from "d3";
import _ from "underscore";
import moment from "moment";

import { color } from "metabase/lib/colors";
import { clipPathReference } from "metabase/lib/dom";
import { COMPACT_CURRENCY_OPTIONS } from "metabase/lib/formatting";
import { adjustYAxisTicksIfNeeded } from "./apply_axis";
import { isHistogramBar } from "./renderer_utils";

const X_LABEL_MIN_SPACING = 2; // minimum space we want to leave between labels
const X_LABEL_ROTATE_90_THRESHOLD = 24; // tick width breakpoint for switching from 45° to 90°
const X_LABEL_HIDE_THRESHOLD = 12; // tick width breakpoint for hiding labels entirely
const X_LABEL_MAX_LABEL_HEIGHT_RATIO = 0.7; // percent rotated labels are allowed to take
const X_LABEL_DISABLED_SPACING = 6; // spacing to use if the x-axis is disabled completely

// +-------------------------------------------------------------------------------------------------------------------+
// |                                                  HELPER FUNCTIONS                                                 |
// +-------------------------------------------------------------------------------------------------------------------+

// moves an element on top of all siblings
function moveToTop(element) {
  if (element) {
    element.parentNode.appendChild(element);
  }
}

// assumes elements are in order from left to right, skips those that aren't
function getMinElementSpacing(elements) {
  let min = null;
  let lastLeft = null;
  for (const element of elements) {
    const { left } = element.getBoundingClientRect();
    if (lastLeft !== null) {
      const delta = left - lastLeft;
      if (delta > 0 && (min == null || delta < min)) {
        min = delta;
      }
    }
    lastLeft = left;
  }
  return min;
}

// +-------------------------------------------------------------------------------------------------------------------+
// |                                                ON RENDER FUNCTIONS                                                |
// +-------------------------------------------------------------------------------------------------------------------+

// The following functions are applied once the chart is rendered.

function onRenderRemoveClipPath(chart) {
  for (const elem of chart.selectAll(".sub, .chart-body")[0]) {
    // prevents dots from being clipped:
    elem.removeAttribute("clip-path");
  }
}

function onRenderMoveContentToTop(chart) {
  for (const element of chart.selectAll(".sub, .chart-body")[0]) {
    // move chart content on top of axis (z-index doesn't work on SVG):
    moveToTop(element);
  }
}

function onRenderReorderCharts(chart) {
  const displayTypes = chart.series.map(
    single => chart.settings.series(single).display,
  );
  const isHeterogenous = _.uniq(displayTypes).length > 0;
  if (isHeterogenous) {
    // move area charts first
    for (const [index, display] of displayTypes.entries()) {
      if (display === "area") {
        moveToTop(chart.select(`.sub._${index}`)[0][0]);
      }
    }
    // move line charts second
    for (const [index, display] of displayTypes.entries()) {
      if (display === "line") {
        moveToTop(chart.select(`.sub._${index}`)[0][0]);
      }
    }
  }
}
function onRenderSetDotStyle(chart) {
  for (const elem of chart.svg().selectAll(".dc-tooltip circle.dot")[0]) {
    // set the color of the dots to the fill color so we can use currentColor in CSS rules:
    elem.style.color = elem.getAttribute("fill");
  }
}

// more than 500 dots is almost certainly too dense, don't waste time computing the voronoi map or figuring out if we should adjust the line width
const MAX_DOTS_FOR_VORONOI = 500;
const MAX_DOTS_FOR_LINE_WIDTH_ADJUSTMENT = 500;

const DOT_OVERLAP_COUNT_LIMIT = 8;
const DOT_OVERLAP_RATIO = 0.1;
const DOT_OVERLAP_DISTANCE = 8;

function onRenderSetLineWidth(chart) {
  const dots = chart.svg()[0][0].querySelectorAll(".dot");
  if (dots.length < MAX_DOTS_FOR_LINE_WIDTH_ADJUSTMENT) {
    const min = getMinElementSpacing(dots);
    if (min > 150) {
      chart.svg().classed("line--heavy", true);
    } else if (min > 75) {
      chart.svg().classed("line--medium", true);
    }
  }
}

function onRenderEnableDots(chart) {
  const markerEnabledByIndex = chart.series.map(
    single => chart.settings.series(single)["line.marker_enabled"],
  );

  // if any settings are auto, determine the correct auto setting
  let enableDotsAuto;
  const hasAuto = _.any(markerEnabledByIndex, enabled => enabled == null);
  if (hasAuto) {
    // get all enabled or auto dots
    const dots = [].concat(
      ...markerEnabledByIndex.map((markerEnabled, index) =>
        markerEnabled === false
          ? []
          : chart.svg().selectAll(`.sub._${index} .dc-tooltip .dot`)[0],
      ),
    );
    if (dots.length > MAX_DOTS_FOR_VORONOI) {
      enableDotsAuto = false;
    } else {
      const vertices = dots.map((e, index) => {
        const rect = e.getBoundingClientRect();
        return [rect.left, rect.top, index];
      });
      const overlappedIndex = {};
      // essentially pairs of vertices closest to each other
      for (const { source, target } of d3.geom.voronoi().links(vertices)) {
        if (
          Math.sqrt(
            Math.pow(source[0] - target[0], 2) +
              Math.pow(source[1] - target[1], 2),
          ) < DOT_OVERLAP_DISTANCE
        ) {
          // if they overlap, mark both as overlapped
          overlappedIndex[source[2]] = overlappedIndex[target[2]] = true;
        }
      }
      const total = vertices.length;
      const overlapping = Object.keys(overlappedIndex).length;
      enableDotsAuto =
        overlapping < DOT_OVERLAP_COUNT_LIMIT ||
        overlapping / total < DOT_OVERLAP_RATIO;
    }
  }

  for (const [index, markerEnabled] of markerEnabledByIndex.entries()) {
    const enableDots = markerEnabled != null ? !!markerEnabled : enableDotsAuto;
    chart
      .svg()
      .select(`.sub._${index}`)
      .classed("enable-dots", enableDots)
      .classed("enable-dots-onhover", !enableDots);
  }
}

const VORONOI_TARGET_RADIUS = 25;
const VORONOI_MAX_POINTS = 300;

/// dispatchUIEvent used below in the "Voroni Hover" stuff
function dispatchUIEvent(element, eventName) {
  const e = document.createEvent("UIEvents");
  // $FlowFixMe
  e.initUIEvent(eventName, true, true, window, 1);
  element.dispatchEvent(e);
}

// logic for determining the bounding shapes for showing tooltips for a given point.
// Wikipedia has a good explanation here: https://en.wikipedia.org/wiki/Voronoi_diagram
function onRenderVoronoiHover(chart) {
  const parent = chart.svg().select("svg > g");
  const dots = chart.svg().selectAll(".sub .dc-tooltip .dot")[0];

  if (dots.length === 0 || dots.length > VORONOI_MAX_POINTS) {
    return;
  }

  const originRect = chart
    .svg()
    .node()
    .getBoundingClientRect();
  const vertices = dots.map(e => {
    const { top, left, width, height } = e.getBoundingClientRect();
    const px = left + width / 2 - originRect.left;
    const py = top + height / 2 - originRect.top;
    return [px, py, e];
  });

  // HACK Atte Keinänen 8/8/17: For some reason the parent node is not present in Jest/Enzyme tests
  // so simply return empty width and height for preventing the need to do bigger hacks in test code
  const { width, height } = parent.node()
    ? parent.node().getBBox()
    : { width: 0, height: 0 };

  const voronoi = d3.geom.voronoi().clipExtent([[0, 0], [width, height]]);

  // circular clip paths to limit distance from actual point
  parent
    .append("svg:g")
    .selectAll("clipPath")
    .data(vertices)
    .enter()
    .append("svg:clipPath")
    .attr("id", (d, i) => "clip-" + i)
    .append("svg:circle")
    .attr("cx", d => d[0])
    .attr("cy", d => d[1])
    .attr("r", VORONOI_TARGET_RADIUS);

  // voronoi layout with clip paths applied
  parent
    .append("svg:g")
    .classed("voronoi", true)
    .selectAll("path")
    .data(voronoi(vertices), d => d && d.join(","))
    .enter()
    .append("svg:path")
    .filter(d => d != null)
    .attr("d", d => "M" + d.join("L") + "Z")
    .attr("clip-path", (d, i) => clipPathReference("clip-" + i))
    // in the functions below e is not an event but the circle element being hovered/clicked
    .on("mousemove", ({ point }) => {
      const e = point[2];
      dispatchUIEvent(e, "mousemove");
      d3.select(e).classed("hover", true);
    })
    .on("mouseleave", ({ point }) => {
      const e = point[2];
      dispatchUIEvent(e, "mouseleave");
      d3.select(e).classed("hover", false);
    })
    .on("click", ({ point }) => {
      const e = point[2];
      dispatchUIEvent(e, "click");
    })
    .order();
}

function onRenderValueLabels(
  chart,
  { formatYValue, xInterval, yAxisSplit, datas },
) {
  const seriesSettings = datas.map((_, seriesIndex) =>
    chart.settings.series(chart.series[seriesIndex]),
  );

  // See if each series is enabled. Fall back to the chart-level setting if undefined.
  let showSeries = seriesSettings.map(
    ({ show_series_values = chart.settings["graph.show_values"] }) =>
      show_series_values,
  );

  if (
    showSeries.every(s => s === false) || // every series setting is off
    chart.settings["stackable.stack_type"] === "normalized" // chart is normalized
  ) {
    return;
  }

  let displays = seriesSettings.map(settings => settings.display);
  if (chart.settings["stackable.stack_type"] === "stacked") {
    // When stacked, zip together the corresponding values and sum them.
    datas = [
      _.zip(...datas).map(datasForSeries =>
        datasForSeries.reduce(
          ([prevX, sum], [x, y = 0] = []) => [prevX || x, sum + y],
          [undefined, 0],
        ),
      ),
    ];

    // Individual series might have display set to something besides the actual stacked display.
    displays = [chart.settings["stackable.stack_display"]];
    showSeries = [true];
  }
  const showAll = chart.settings["graph.label_value_frequency"] === "all";

  // Count max points in a single series to estimate when labels should be hidden
  const maxSeriesLength = Math.max(...datas.map(d => d.length));

  const barWidth = chart
    .svg()
    .select("rect")[0][0]
    .getAttribute("width");
  const barCount = displays.filter(d => d === "bar").length;

  // Update datas to use named x/y and include `showLabelBelow`.
  // We need to add `showLabelBelow` before data is filtered to show every nth value.
  datas = datas.map((data, seriesIndex) => {
    if (!showSeries[seriesIndex]) {
      // We need to keep the series in `datas` to place the labels correctly over grouped bar charts.
      // Instead, we remove all the data so no labels are displayed.
      return [];
    }
    const display = displays[seriesIndex];

    return data
      .map(([x, y], i) => {
        const isLocalMin =
          // first point or prior is greater than y
          (i === 0 || data[i - 1][1] > y) &&
          // last point point or next is greater than y
          (i === data.length - 1 || data[i + 1][1] > y);
        const showLabelBelow = isLocalMin && display === "line";
        const rotated = barCount > 1 && display === "bar" && barWidth < 40;
        const hidden =
          !showAll && barCount > 1 && display === "bar" && barWidth < 20;
        return { x, y, showLabelBelow, seriesIndex, rotated, hidden };
      })
      .filter(d => display !== "bar" || d.y !== 0);
  });

  const formattingSetting = chart.settings["graph.label_value_formatting"];
  const compactForSeries = datas.map(data => {
    if (formattingSetting === "compact") {
      return true;
    }
    if (formattingSetting === "full") {
      return false;
    }
    // for "auto" we use compact if it shortens avg label length by >3 chars
    const getAvgLength = compact => {
      const options = {
        compact,
        // We include compact currency options here for both compact and
        // non-compact formatting. This prevents auto's logic from depending on
        // those settings.
        ...COMPACT_CURRENCY_OPTIONS,
        // We need this to ensure the settings are used. Otherwise, a cached
        // _numberFormatter would take precedence.
        _numberFormatter: undefined,
      };
      const lengths = data.map(d => formatYValue(d.y, options).length);
      return lengths.reduce((sum, l) => sum + l, 0) / lengths.length;
    };
    return getAvgLength(true) < getAvgLength(false) - 3;
  });

  // use the chart body so things line up properly
  const parent = chart.svg().select(".chart-body");

  const xScale = chart.x();
  const yScaleForSeries = index =>
    yAxisSplit[0].includes(index) ? chart.y() : chart.rightY();

  // Ordinal bar charts and histograms need extra logic to center the label.
  const xShifts = displays.map((display, index) => {
    const thisChart = chart.children()[index];
    const barIndex = displays.slice(0, index).filter(d => d === "bar").length;
    let xShift = 0;

    if (xScale.rangeBand) {
      if (display === "bar") {
        const xShiftForSeries = xScale.rangeBand() / barCount;
        xShift += (barIndex + 0.5) * xShiftForSeries;
      } else {
        xShift += xScale.rangeBand() / 2;
      }
      if (displays.some(d => d === "bar") && displays.some(d => d !== "bar")) {
        xShift += (chart._rangeBandPadding() * xScale.rangeBand()) / 2;
      }
    } else if (
      // non-ordinal bar charts don't have rangeBand set, but still need xShifting if they're grouped.
      thisChart.barPadding
    ) {
      // For these timeseries/quantitative scales, we look at the distance between two points one "interval" apart.
      // We then scale to remove the padding and divide by the number of bars to get the per-bar shift from the center.
      const startOfDomain = xScale.domain()[0];
      const oneIntervalOver = moment.isMoment(startOfDomain)
        ? startOfDomain.clone().add(xInterval.count, xInterval.interval)
        : startOfDomain + xInterval;
      const groupWidth =
        (xScale(oneIntervalOver) - xScale(startOfDomain)) *
        (1 - thisChart.barPadding());
      xShift -= groupWidth / 2;
      const xShiftForSeries = groupWidth / barCount;
      xShift += (barIndex + 0.5) * xShiftForSeries;
    }

    if (
      isHistogramBar({ settings: chart.settings, chartType: display }) &&
      displays.length === 1
    ) {
      // this has to match the logic in `doHistogramBarStuff`
      const [x1, x2] = chart
        .svg()
        .selectAll("rect")
        .flat()
        .map(r => parseFloat(r.getAttribute("x")));
      const barWidth = x2 - x1;
      xShift += barWidth / 2;
    }
    return xShift;
  });

  const xyPos = ({ x, y, showLabelBelow, seriesIndex }) => {
    const yScale = yScaleForSeries(seriesIndex);
    const xPos = xShifts[seriesIndex] + xScale(x);
    let yPos = yScale(y) + (showLabelBelow ? 18 : -8);
    // if the yPos is below the x axis, move it to be above the data point
    const [yMax] = yScale.range();
    if (yPos > yMax) {
      yPos = yScale(y) - 8;
    }
    return { xPos, yPos, yHeight: yMax - yPos };
  };

  const MIN_ROTATED_HEIGHT = 50;
  const addLabels = (data, compact = null) => {
    // make sure we don't add .value-lables multiple times
    parent.select(".value-labels").remove();
    // Safari had an issue with rendering paint-order: stroke. To work around
    // that, we create two text labels: one for the the black text and another
    // for the white outline behind it.
    const labelGroups = parent
      .append("svg:g")
      .classed("value-labels", true)
      .selectAll("g")
      .data(data)
      .enter()
      .append("g")
      .attr("text-anchor", d =>
        !d.rotated
          ? "middle"
          : xyPos(d).yHeight < MIN_ROTATED_HEIGHT
          ? "start"
          : "end",
      )
      .attr("transform", d => {
        const { xPos, yPos, yHeight } = xyPos(d);
        const transforms = [`translate(${xPos}, ${yPos})`];
        if (d.rotated) {
          transforms.push(
            "rotate(-90)",
            `translate(${yHeight < MIN_ROTATED_HEIGHT ? -3 : -15}, 4)`,
          );
        }
        return transforms.join(" ");
      });

    ["value-label-outline", "value-label"].forEach(klass =>
      labelGroups
        .append("text")
        .attr("class", klass)
        .text(({ y, seriesIndex }) =>
          formatYValue(y, {
            compact: compact === null ? compactForSeries[seriesIndex] : compact,
          }),
        ),
    );
  };

  const nthForSeries = datas.map((data, index) => {
    if (showAll || (barCount > 1 && displays[index] === "bar")) {
      // show all is turned on or this is a bar in a grouped bar chart
      return 1;
    }
    // auto fit
    // Render a sample of rows to estimate average label size.
    // We use that estimate to compute the label interval.
    const LABEL_PADDING = 6;
    const MAX_SAMPLE_SIZE = 30;
    const sampleStep = Math.ceil(maxSeriesLength / MAX_SAMPLE_SIZE);
    const sample = data.filter((d, i) => i % sampleStep === 0);
    addLabels(sample, compactForSeries[index]);
    const totalWidth = chart
      .svg()
      .selectAll(".value-label-outline")
      .flat()
      .reduce((sum, label) => sum + label.getBoundingClientRect().width, 0);
    const labelWidth = totalWidth / sample.length + LABEL_PADDING;

    const { width: chartWidth } = chart
      .svg()
      .select(".axis.x")
      .node()
      .getBoundingClientRect();

    return Math.ceil((labelWidth * maxSeriesLength) / chartWidth);
  });

  const MIN_SPACING = 20;
  _.chain(datas)
    .flatten()
    .filter(d => displays[d.seriesIndex] === "line")
    .map(d => ({ d, ...xyPos(d) }))
    .groupBy(({ xPos }) => xPos)
    .values()
    .each(group => {
      const sortedByY = _.sortBy(group, ({ yPos }) => yPos);
      let prev;
      for (const { d, yPos } of sortedByY) {
        if (prev == null || yPos - prev > MIN_SPACING) {
          // there's enough space between this label and the prev
          prev = yPos;
          continue;
        }

        if (!d.showLabelBelow) {
          // try flipping the label below to get farther from previous label
          const flippedYPos = xyPos({ ...d, showLabelBelow: true }).yPos;
          if (flippedYPos - prev > MIN_SPACING) {
            d.showLabelBelow = true;
            prev = flippedYPos;
            continue;
          }
        }

        // hide this label and don't update prev so it isn't considered for collisions
        d.hidden = true;
      }
    });

  addLabels(
    datas.flatMap(data =>
      data.filter((d, i) => i % nthForSeries[d.seriesIndex] === 0 && !d.hidden),
    ),
  );

  moveToTop(
    chart
      .svg()
      .select(".value-labels")
      .node().parentNode,
  );
}

function onRenderCleanupGoalAndTrend(chart, onGoalHover, isSplitAxis) {
  // remove dots
  chart.selectAll(".goal .dot, .trend .dot").remove();

  // move to end of the parent node so it's on top
  chart.selectAll(".goal, .trend").each(function() {
    this.parentNode.appendChild(this);
  });

  // add the label
  const goalLine = chart.selectAll(".goal .line")[0][0];
  if (goalLine) {
    // stretch the goal line all the way across, use x axis as reference
    const xAxisLine = chart.selectAll(".axis.x .domain")[0][0];

    // HACK Atte Keinänen 8/8/17: For some reason getBBox method is not present in Jest/Enzyme tests
    if (xAxisLine && goalLine.getBBox) {
      goalLine.setAttribute(
        "d",
        `M0,${goalLine.getBBox().y}L${xAxisLine.getBBox().width},${
          goalLine.getBBox().y
        }`,
      );
    }

    const { x, y, width } = goalLine.getBBox
      ? goalLine.getBBox()
      : { x: 0, y: 0, width: 0 };

    const labelOnRight = !isSplitAxis;
    chart
      .selectAll(".goal .stack._0")
      .append("text")
      .text(chart.settings["graph.goal_label"])
      .attr({
        x: labelOnRight ? x + width : x,
        y: y - 5,
        "text-anchor": labelOnRight ? "end" : "start",
        "font-weight": "bold",
        fill: color("text-medium"),
      })
      .on("mouseenter", function() {
        onGoalHover(this);
      })
      .on("mouseleave", function() {
        onGoalHover(null);
      });
  }
}

function onRenderHideDisabledLabels(chart) {
  if (!chart.settings["graph.x_axis.labels_enabled"]) {
    chart.selectAll(".x-axis-label").remove();
  }
  if (!chart.settings["graph.y_axis.labels_enabled"]) {
    chart.selectAll(".y-axis-label").remove();
  }
}

function onRenderHideDisabledAxis(chart) {
  if (!chart.settings["graph.x_axis.axis_enabled"]) {
    chart.selectAll(".axis.x").remove();
  }
  if (!chart.settings["graph.y_axis.axis_enabled"]) {
    chart.selectAll(".axis.y, .axis.yr").remove();
  }
}

function onRenderHideBadAxis(chart) {
  if (chart.selectAll(".axis.x .tick")[0].length === 0) {
    chart.selectAll(".axis.x").remove();
  }
}

function onRenderDisableClickFiltering(chart) {
  chart.selectAll("rect.bar").on("click", d => {
    chart.filter(null);
    chart.filter(d.key);
  });
}

function onRenderFixStackZIndex(chart) {
  // reverse the order of .stack-list and .dc-tooltip-list children so 0 points in stacked
  // charts don't appear on top of non-zero points
  for (const list of chart.selectAll(".stack-list, .dc-tooltip-list")[0]) {
    for (const child of list.childNodes) {
      list.insertBefore(list.firstChild, child);
    }
  }
}

function onRenderSetClassName(chart, isStacked) {
  chart.svg().classed("stacked", isStacked);
}

function getXAxisRotation(chart) {
  const match = String(chart.settings["graph.x_axis.axis_enabled"] || "").match(
    /^rotate-(\d+)$/,
  );
  if (match) {
    return parseInt(match[1], 10);
  } else {
    return 0;
  }
}

function onRenderRotateAxis(chart) {
  const degrees = getXAxisRotation(chart);
  if (degrees !== 0) {
    chart.selectAll("g.x text").attr("transform", function() {
      const { width, height } = this.getBBox();
      return (
        // translate left half the width so the right edge is at the tick
        `translate(-${width / 2},${-height / 2}) ` +
        // rotate counter-clockwise around the right edge
        `rotate(${-degrees}, ${width / 2}, ${height})`
      );
    });
  }
}

function onRenderAddExtraClickHandlers(chart) {
  const { onEditBreakout } = chart.props;
  if (onEditBreakout) {
    chart
      .svg()
      .select(".x-axis-label")
      .classed("cursor-pointer", true)
      .on("click", () => onEditBreakout(d3.event, 0));
  }
}

// the various steps that get called
function onRender(
  chart,
  {
    onGoalHover,
    isSplitAxis,
    xInterval,
    yAxisSplit,
    isStacked,
    formatYValue,
    datas,
  },
) {
  onRenderRemoveClipPath(chart);
  onRenderMoveContentToTop(chart);
  onRenderReorderCharts(chart);
  onRenderSetDotStyle(chart);
  onRenderSetLineWidth(chart);
  onRenderEnableDots(chart);
  onRenderVoronoiHover(chart);
  onRenderCleanupGoalAndTrend(chart, onGoalHover, isSplitAxis); // do this before hiding x-axis
  onRenderValueLabels(chart, { formatYValue, xInterval, yAxisSplit, datas });
  onRenderHideDisabledLabels(chart);
  onRenderHideDisabledAxis(chart);
  onRenderHideBadAxis(chart);
  onRenderDisableClickFiltering(chart);
  onRenderFixStackZIndex(chart);
  onRenderSetClassName(chart, isStacked);
  onRenderRotateAxis(chart);
  onRenderAddExtraClickHandlers(chart);
}

// +-------------------------------------------------------------------------------------------------------------------+
// |                                                   BEFORE RENDER                                                   |
// +-------------------------------------------------------------------------------------------------------------------+

// run these first so the rest of the margin computations take it into account
function beforeRenderHideDisabledAxesAndLabels(chart) {
  onRenderHideDisabledLabels(chart);
  onRenderHideDisabledAxis(chart);
  onRenderHideBadAxis(chart);
}

// min margin
const MARGIN_TOP_MIN = 20; // needs to be large enough for goal line text
const MARGIN_BOTTOM_MIN = 10;
const MARGIN_HORIZONTAL_MIN = 20;

// extra padding for axis
const X_AXIS_PADDING = 0;
const Y_AXIS_PADDING = 8;

function adjustMargin(
  chart,
  margin,
  direction,
  padding,
  axisSelector,
  labelSelector,
) {
  const axis = chart.select(axisSelector).node();
  const label = chart.select(labelSelector).node();
  const axisSize = axis ? axis.getBoundingClientRect()[direction] + 10 : 0;
  const labelSize = label ? label.getBoundingClientRect()[direction] + 5 : 0;
  chart.margins()[margin] = axisSize + labelSize + padding;
}

function computeMinHorizontalMargins(chart) {
  const min = { left: 0, right: 0 };
  const ticks = chart.selectAll(".axis.x .tick text")[0];
  if (ticks.length > 0) {
    const chartRect = chart
      .select("svg")
      .node()
      .getBoundingClientRect();
    min.left =
      chart.margins().left -
      (ticks[0].getBoundingClientRect().left - chartRect.left);
    min.right =
      chart.margins().right -
      (chartRect.right - ticks[ticks.length - 1].getBoundingClientRect().right);
  }
  return min;
}

function computeXAxisLabelMaxSize(chart) {
  let maxWidth = 0;
  let maxHeight = 0;
  chart.selectAll("g.x text").each(function() {
    const { width, height } = this.getBBox();
    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);
  });
  return { width: maxWidth, height: maxHeight };
}

function rotateSize(size, rotation) {
  return {
    width: Math.sin(rotation * (Math.PI / 180)) * size.width,
    height: Math.sin(rotation * (Math.PI / 180)) * size.height,
  };
}

function computeXAxisMargin(chart) {
  if (chart.settings["graph.x_axis.axis_enabled"] === false) {
    return X_LABEL_DISABLED_SPACING;
  }
  const rotation = getXAxisRotation(chart);
  const maxSize = computeXAxisLabelMaxSize(chart);
  const rotatedMaxSize = rotateSize(maxSize, rotation);
  return Math.max(0, rotatedMaxSize.width - maxSize.height); // subtract the existing height
}

export function checkXAxisLabelOverlap(chart, selector = "g.x text") {
  const rects = [];
  for (const elem of chart.selectAll(selector)[0]) {
    rects.push(elem.getBoundingClientRect());
    if (
      rects.length > 1 &&
      rects[rects.length - 2].right + X_LABEL_MIN_SPACING >
        rects[rects.length - 1].left
    ) {
      return true;
    }
  }
  return false;
}

function checkLabelHeight(chart, rotation) {
  const rotatedMaxSize = rotateSize(
    computeXAxisLabelMaxSize(chart),
    rotation + 180,
  );
  const xAxisSize = chart.selectAll("g.y")[0][0].getBBox();
  const ratio = Math.abs(rotatedMaxSize.width) / xAxisSize.height;
  return ratio < X_LABEL_MAX_LABEL_HEIGHT_RATIO;
}

function computeXAxisSpacing(chart) {
  const rects = [];
  let minXAxisSpacing = Infinity;
  for (const elem of chart.selectAll("g.x text")[0]) {
    rects.push(elem.getBoundingClientRect());
    if (rects.length > 1) {
      const left = rects[rects.length - 2],
        right = rects[rects.length - 1];
      const xAxisSpacing =
        right.left + right.width / 2 - (left.left + left.width / 2);
      minXAxisSpacing = Math.min(minXAxisSpacing, xAxisSpacing);
    }
  }
  return minXAxisSpacing;
}

function beforeRenderComputeXAxisLabelType(chart) {
  // treat graph.x_axis.axis_enabled === true as "auto"
  if (chart.settings["graph.x_axis.axis_enabled"] === true) {
    const overlaps = checkXAxisLabelOverlap(chart);
    if (overlaps) {
      if (chart.isOrdinal()) {
        const spacing = computeXAxisSpacing(chart);
        if (spacing < X_LABEL_HIDE_THRESHOLD) {
          chart.settings["graph.x_axis.axis_enabled"] = false;
        } else if (spacing < X_LABEL_ROTATE_90_THRESHOLD) {
          if (checkLabelHeight(chart, 90)) {
            chart.settings["graph.x_axis.axis_enabled"] = "rotate-90";
          } else {
            chart.settings["graph.x_axis.axis_enabled"] = false;
          }
        } else {
          if (checkLabelHeight(chart, 45)) {
            chart.settings["graph.x_axis.axis_enabled"] = "rotate-45";
          } else {
            chart.settings["graph.x_axis.axis_enabled"] = false;
          }
        }
      } else {
        chart.settings["graph.x_axis.axis_enabled"] = false;
      }
    }
  }
}

function beforeRenderFixMargins(chart) {
  // run before adjusting margins
  const mins = computeMinHorizontalMargins(chart);
  const xAxisMargin = computeXAxisMargin(chart);

  // re-adjust Y axis ticks to account for xAxisMargin due to rotated labels
  adjustYAxisTicksIfNeeded(chart.yAxis(), chart.height() - xAxisMargin);
  adjustYAxisTicksIfNeeded(chart.rightYAxis(), chart.height() - xAxisMargin);

  // adjust the margins to fit the X and Y axis tick and label sizes, if enabled
  adjustMargin(
    chart,
    "bottom",
    "height",
    X_AXIS_PADDING + xAxisMargin,
    ".axis.x",
    ".x-axis-label",
  );
  adjustMargin(
    chart,
    "left",
    "width",
    Y_AXIS_PADDING,
    ".axis.y",
    ".y-axis-label.y-label",
  );
  adjustMargin(
    chart,
    "right",
    "width",
    Y_AXIS_PADDING,
    ".axis.yr",
    ".y-axis-label.yr-label",
  );

  // set margins to the max of the various mins
  chart.margins().top = Math.max(MARGIN_TOP_MIN, chart.margins().top);
  chart.margins().left = Math.max(
    MARGIN_HORIZONTAL_MIN,
    chart.margins().left,
    mins.left,
  );
  chart.margins().right = Math.max(
    MARGIN_HORIZONTAL_MIN,
    chart.margins().right,
    mins.right,
  );
  chart.margins().bottom = Math.max(MARGIN_BOTTOM_MIN, chart.margins().bottom);
}

// collection of function calls that get made *before* we tell the Chart to render
function beforeRender(chart) {
  beforeRenderComputeXAxisLabelType(chart);
  beforeRenderHideDisabledAxesAndLabels(chart);
  beforeRenderFixMargins(chart);
}

// +-------------------------------------------------------------------------------------------------------------------+
// |                                              PUTTING IT ALL TOGETHER                                              |
// +-------------------------------------------------------------------------------------------------------------------+

/// once chart has rendered and we can access the SVG, do customizations to axis labels / etc that you can't do through dc.js
export default function lineAndBarOnRender(chart, args) {
  beforeRender(chart);
  chart.on("renderlet.on-render", () => onRender(chart, args));
  chart.render();
}
