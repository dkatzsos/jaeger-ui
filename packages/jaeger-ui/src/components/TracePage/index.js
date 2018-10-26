// @flow

// Copyright (c) 2017 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as React from 'react';
import _clamp from 'lodash/clamp';
import _mapValues from 'lodash/mapValues';
import _maxBy from 'lodash/maxBy';
import _values from 'lodash/values';
import { connect } from 'react-redux';
import type { RouterHistory, Match } from 'react-router-dom';
import { bindActionCreators } from 'redux';
import { Input } from 'antd';

import ArchiveNotifier from './ArchiveNotifier';
import { actions as archiveActions } from './ArchiveNotifier/duck';
import { trackFilter, trackRange } from './index.track';
import { merge as mergeShortcuts, reset as resetShortcuts } from './keyboard-shortcuts';
import { cancel as cancelScroll, scrollBy, scrollTo } from './scroll-page';
import ScrollManager from './ScrollManager';
import SpanGraph from './SpanGraph';
import TracePageHeader from './TracePageHeader';
import { trackSlimHeaderToggle } from './TracePageHeader.track';
import TraceTimelineViewer from './TraceTimelineViewer';
import ErrorMessage from '../common/ErrorMessage';
import LoadingIndicator from '../common/LoadingIndicator';
import * as jaegerApiActions from '../../actions/jaeger-api';
import { fetchedState } from '../../constants';
import { getTraceName } from '../../model/trace-viewer';
import prefixUrl from '../../utils/prefix-url';

import type { CombokeysHandler, ShortcutCallbacks } from './keyboard-shortcuts';
import type { ViewRange, ViewRangeTimeUpdate } from './types';
import type { FetchedTrace, ReduxState } from '../../types';
import type { KeyValuePair, Span } from '../../types/trace';
import type { TraceArchive } from '../../types/archive';

import './index.css';

type TracePageProps = {
  archiveEnabled: boolean,
  archiveTraceState: ?TraceArchive,
  archiveTrace: string => void,
  acknowledgeArchive: string => void,
  fetchTrace: string => void,
  history: RouterHistory,
  id: string,
  trace: ?FetchedTrace,
};

type TracePageState = {
  headerHeight: ?number,
  slimView: boolean,
  textFilter: string,
  findMatchesIDs: ?Set<string>,
  viewRange: ViewRange,
};

// export for tests
export const VIEW_MIN_RANGE = 0.01;
const VIEW_CHANGE_BASE = 0.005;
const VIEW_CHANGE_FAST = 0.05;

// export for tests
export const shortcutConfig = {
  panLeft: [-VIEW_CHANGE_BASE, -VIEW_CHANGE_BASE],
  panLeftFast: [-VIEW_CHANGE_FAST, -VIEW_CHANGE_FAST],
  panRight: [VIEW_CHANGE_BASE, VIEW_CHANGE_BASE],
  panRightFast: [VIEW_CHANGE_FAST, VIEW_CHANGE_FAST],
  zoomIn: [VIEW_CHANGE_BASE, -VIEW_CHANGE_BASE],
  zoomInFast: [VIEW_CHANGE_FAST, -VIEW_CHANGE_FAST],
  zoomOut: [-VIEW_CHANGE_BASE, VIEW_CHANGE_BASE],
  zoomOutFast: [-VIEW_CHANGE_FAST, VIEW_CHANGE_FAST],
};

// export for tests
export function makeShortcutCallbacks(adjRange: (number, number) => void): ShortcutCallbacks {
  function getHandler([startChange, endChange]): CombokeysHandler {
    return function combokeyHandler(event: SyntheticKeyboardEvent<any>) {
      event.preventDefault();
      adjRange(startChange, endChange);
    };
  }
  return _mapValues(shortcutConfig, getHandler);
}

// export for tests
export class TracePageImpl extends React.PureComponent<TracePageProps, TracePageState> {
  props: TracePageProps;
  state: TracePageState;

  _headerElm: ?Element;
  _searchBar: { current: Input | null };
  _scrollManager: ScrollManager;

  constructor(props: TracePageProps) {
    super(props);
    this.state = {
      headerHeight: null,
      slimView: false,
      textFilter: '',
      findMatchesIDs: null,
      viewRange: {
        time: {
          current: [0, 1],
        },
      },
    };
    this._headerElm = null;
    const { trace } = props;
    this._scrollManager = new ScrollManager(trace && trace.data, {
      scrollBy,
      scrollTo,
    });
    this._searchBar = React.createRef();
    resetShortcuts();
  }

  componentDidMount() {
    this.ensureTraceFetched();
    this.updateViewRangeTime(0, 1);
    /* istanbul ignore if */
    if (!this._scrollManager) {
      throw new Error('Invalid state - scrollManager is unset');
    }
    const {
      scrollPageDown,
      scrollPageUp,
      scrollToNextVisibleSpan,
      scrollToPrevVisibleSpan,
    } = this._scrollManager;
    const adjViewRange = (a: number, b: number) => this._adjustViewRange(a, b, 'kbd');
    const shortcutCallbacks = makeShortcutCallbacks(adjViewRange);
    shortcutCallbacks.scrollPageDown = scrollPageDown;
    shortcutCallbacks.scrollPageUp = scrollPageUp;
    shortcutCallbacks.scrollToNextVisibleSpan = scrollToNextVisibleSpan;
    shortcutCallbacks.scrollToPrevVisibleSpan = scrollToPrevVisibleSpan;
    shortcutCallbacks.clearSearch = this.clearSearch;
    shortcutCallbacks.searchSpans = this.focusOnSearchBar;
    mergeShortcuts(shortcutCallbacks);
  }

  componentWillReceiveProps(nextProps: TracePageProps) {
    if (this._scrollManager) {
      const { trace } = nextProps;
      this._scrollManager.setTrace(trace && trace.data);
    }
  }

  componentDidUpdate({ id: prevID }: TracePageProps) {
    const { id, trace } = this.props;
    this.setHeaderHeight(this._headerElm);
    if (!trace) {
      this.ensureTraceFetched();
      return;
    }
    if (prevID !== id) {
      this.updateViewRangeTime(0, 1);
      this.clearSearch();
    }
  }

  componentWillUnmount() {
    resetShortcuts();
    cancelScroll();
    if (this._scrollManager) {
      this._scrollManager.destroy();
      this._scrollManager = new ScrollManager(undefined, {
        scrollBy,
        scrollTo,
      });
    }
  }

  _adjustViewRange(startChange: number, endChange: number, trackSrc: string) {
    const [viewStart, viewEnd] = this.state.viewRange.time.current;
    let start = _clamp(viewStart + startChange, 0, 0.99);
    let end = _clamp(viewEnd + endChange, 0.01, 1);
    if (end - start < VIEW_MIN_RANGE) {
      if (startChange < 0 && endChange < 0) {
        end = start + VIEW_MIN_RANGE;
      } else if (startChange > 0 && endChange > 0) {
        end = start + VIEW_MIN_RANGE;
      } else {
        const center = viewStart + (viewEnd - viewStart) / 2;
        start = center - VIEW_MIN_RANGE / 2;
        end = center + VIEW_MIN_RANGE / 2;
      }
    }
    this.updateViewRangeTime(start, end, trackSrc);
  }

  setHeaderHeight = (elm: ?Element) => {
    this._headerElm = elm;
    if (elm) {
      if (this.state.headerHeight !== elm.clientHeight) {
        this.setState({ headerHeight: elm.clientHeight });
      }
    } else if (this.state.headerHeight) {
      this.setState({ headerHeight: null });
    }
  };

  filterSpans = (textFilter: string) => {
    const spans = this.props.trace && this.props.trace.data && this.props.trace.data.spans;
    if (!spans) return null;

    // if a span field includes at least one filter in includeFilters, the span is a match
    const includeFilters = [];

    // values with keys that include text in any one of the excludeKeys will be ignored
    const excludeKeys = [];

    // split textFilter by whitespace, remove empty strings, and extract includeFilters and excludeKeys
    textFilter
      .split(' ')
      .map(s => s.trim())
      .filter(s => s)
      .forEach(w => {
        if (w[0] === '-') {
          excludeKeys.push(w.substr(1).toLowerCase());
        } else {
          includeFilters.push(w.toLowerCase());
        }
      });

    const isTextInFilters = (filters: Array<string>, text: string) =>
      filters.some(filter => text.toLowerCase().includes(filter));

    const isTextInKeyValues = (kvs: Array<KeyValuePair>) =>
      kvs
        ? kvs.some(kv => {
            // ignore checking key and value for a match if key is in excludeKeys
            if (isTextInFilters(excludeKeys, kv.key)) return false;
            // match if key or value matches an item in includeFilters
            return (
              isTextInFilters(includeFilters, kv.key) || isTextInFilters(includeFilters, kv.value.toString())
            );
          })
        : false;

    const isSpanAMatch = (span: Span) =>
      isTextInFilters(includeFilters, span.operationName) ||
      isTextInFilters(includeFilters, span.process.serviceName) ||
      isTextInKeyValues(span.tags) ||
      span.logs.some(log => isTextInKeyValues(log.fields)) ||
      isTextInKeyValues(span.process.tags);

    // declare as const because need to disambiguate the type
    const rv: Set<string> = new Set(spans.filter(isSpanAMatch).map((span: Span) => span.spanID));
    return rv;
  };

  updateTextFilter = (textFilter: string) => {
    let findMatchesIDs;
    if (textFilter.trim()) {
      findMatchesIDs = this.filterSpans(textFilter);
    } else {
      findMatchesIDs = null;
    }
    trackFilter(textFilter);
    this.setState({ textFilter, findMatchesIDs });
  };

  clearSearch = () => {
    this.updateTextFilter('');
    if (this._searchBar.current) this._searchBar.current.blur();
  };

  focusOnSearchBar = () => {
    if (this._searchBar.current) this._searchBar.current.focus();
  };

  updateViewRangeTime = (start: number, end: number, trackSrc?: string) => {
    if (trackSrc) {
      trackRange(trackSrc, [start, end], this.state.viewRange.time.current);
    }
    const time = { current: [start, end] };
    const viewRange = { ...this.state.viewRange, time };
    this.setState({ viewRange });
  };

  updateNextViewRangeTime = (update: ViewRangeTimeUpdate) => {
    const time = { ...this.state.viewRange.time, ...update };
    const viewRange = { ...this.state.viewRange, time };
    this.setState({ viewRange });
  };

  toggleSlimView = () => {
    const { slimView } = this.state;
    trackSlimHeaderToggle(!slimView);
    this.setState({ slimView: !slimView });
  };

  archiveTrace = () => {
    const { id, archiveTrace } = this.props;
    archiveTrace(id);
  };

  acknowledgeArchive = () => {
    const { id, acknowledgeArchive } = this.props;
    acknowledgeArchive(id);
  };

  ensureTraceFetched() {
    const { fetchTrace, trace, id } = this.props;
    if (!trace) {
      fetchTrace(id);
      return;
    }
    const { history } = this.props;
    if (id && id !== id.toLowerCase()) {
      history.push(prefixUrl(`/trace/${id.toLowerCase()}`));
    }
  }

  render() {
    const { archiveEnabled, archiveTraceState, trace } = this.props;
    const { slimView, headerHeight, textFilter, viewRange, findMatchesIDs } = this.state;
    if (!trace || trace.state === fetchedState.LOADING) {
      return <LoadingIndicator className="u-mt-vast" centered />;
    }
    const { data } = trace;
    if (trace.state === fetchedState.ERROR || !data) {
      return <ErrorMessage className="ub-m3" error={trace.error || 'Unknown error'} />;
    }
    const { duration, processes, spans, startTime, traceID } = data;
    const maxSpanDepth = _maxBy(spans, 'depth').depth + 1;
    const numberOfServices = new Set(_values(processes).map(p => p.serviceName)).size;
    return (
      <div>
        {archiveEnabled && (
          <ArchiveNotifier acknowledge={this.acknowledgeArchive} archivedState={archiveTraceState} />
        )}
        <div className="Tracepage--headerSection" ref={this.setHeaderHeight}>
          <TracePageHeader
            duration={duration}
            maxDepth={maxSpanDepth}
            name={getTraceName(spans)}
            numServices={numberOfServices}
            numSpans={spans.length}
            slimView={slimView}
            timestamp={startTime}
            traceID={traceID}
            onSlimViewClicked={this.toggleSlimView}
            textFilter={textFilter}
            prevResult={this._scrollManager.scrollToPrevVisibleSpan}
            nextResult={this._scrollManager.scrollToNextVisibleSpan}
            clearSearch={this.clearSearch}
            resultCount={findMatchesIDs ? findMatchesIDs.size : 0}
            updateTextFilter={this.updateTextFilter}
            archiveButtonVisible={archiveEnabled}
            onArchiveClicked={this.archiveTrace}
            ref={this._searchBar}
          />
          {!slimView && (
            <SpanGraph
              trace={data}
              viewRange={viewRange}
              updateNextViewRangeTime={this.updateNextViewRangeTime}
              updateViewRangeTime={this.updateViewRangeTime}
            />
          )}
        </div>
        {headerHeight && (
          <section style={{ paddingTop: headerHeight }}>
            <TraceTimelineViewer
              registerAccessors={this._scrollManager.setAccessors}
              findMatchesIDs={findMatchesIDs}
              trace={data}
              updateNextViewRangeTime={this.updateNextViewRangeTime}
              updateViewRangeTime={this.updateViewRangeTime}
              viewRange={viewRange}
            />
          </section>
        )}
      </div>
    );
  }
}

// export for tests
export function mapStateToProps(state: ReduxState, ownProps: { match: Match }) {
  const { id } = ownProps.match.params;
  const trace = id ? state.trace.traces[id] : null;
  const archiveTraceState = id ? state.archive[id] : null;
  const archiveEnabled = Boolean(state.config.archiveEnabled);
  return { archiveEnabled, archiveTraceState, id, trace };
}

// export for tests
export function mapDispatchToProps(dispatch: Function) {
  const { fetchTrace } = bindActionCreators(jaegerApiActions, dispatch);
  const { archiveTrace, acknowledge: acknowledgeArchive } = bindActionCreators(archiveActions, dispatch);
  return { acknowledgeArchive, archiveTrace, fetchTrace };
}

export default connect(mapStateToProps, mapDispatchToProps)(TracePageImpl);
