import React from 'react'
import {
  Text,
  View,
  ScrollView,
  StyleSheet,
  Dimensions,
  RefreshControl,
} from 'react-native'
import store from 'react-native-simple-store'
import { observer } from 'mobx-react/native'

import { AsyncStorageKey, FontSize, Margin, FontFamily } from './Constants'
import Popover from './Popover'
import { Color } from './Constants'
import bibleStore from './BibleStore'
import 'react-native-console-time-polyfill'
import NavigationHeader from './NavigationHeader'
import QuickSettings from './QuickSettings'
import { RecyclerListView, LayoutProvider } from 'recyclerlistview'
import StrongsPopover from './StrongsPopover'
import { ActivityIndicator } from 'react-native-paper'
import StrongsWord from './StrongsWord'

@observer
export default class ReadingScreen extends React.Component<any, any> {
  static navigationOptions = {
    headerShown: false,
  }
  targetVerseNum = 7
  targetVerseRef?: View | null
  listRef?: ScrollView | null

  constructor(props) {
    super(props)
    this.state = {
      popoverIsVisible: false,
      layoutProvider: new LayoutProvider(
        () => 'layoutType',
        (type, dim, index) => {}
      ),
      refreshing: false,
      loadingMoreOnBottom: true,
      strongsNumbers: [],
      visibleChapterNum: null,
    }
  }

  async componentDidMount() {
    await this.setupFirstTimeUserIfNeeded()
    await bibleStore.initialize()
  }

  async setupFirstTimeUserIfNeeded() {
    const hasLaunched = await store.get(AsyncStorageKey.HAS_LAUNCHED)
    if (!hasLaunched) {
      this.props.navigation.navigate('Onboarding')
      bibleStore.loadSearchIndex()
    }
  }

  bibleSection = (item, index) => (
    <React.Fragment key={`section-${index}`}>
      {this.sectionTitle(item.title, index)}
      {this.mappedContents(item, index)}
    </React.Fragment>
  )

  sectionTitle = (title, index) => (
    <Text style={styles.page__section__title} key={`title-${index}`}>
      {title}
    </Text>
  )

  renderItem = (item, index) => {
    if (!('type' in item)) {
      return (
        <React.Fragment key={`item-${index}`}>
          {this.verseNumber(item, index)}
          {this.phrase(item, index)}
        </React.Fragment>
      )
    }
    if (item.type === 'group') {
      if (item.groupType === 'paragraph') {
        return this.paragraph(item, index)
      }
      if (item.groupType === 'indent') {
        return this.indentedGroup(item, index)
      }
    }
    return this.mappedContents(item, index)
  }

  phrase = (item, index) => {
    if ('strongs' in item) {
      return (
        <StrongsWord onWordPress={this.onWordPress} item={item} index={index} />
      )
    }
    return (
      <Text
        style={styles.page__phrase}
        key={`phrase-${index}`}
      >{`${item.content} `}</Text>
    )
  }

  paragraph = (item, index) => (
    <React.Fragment key={`paragraph-${index}`}>
      {this.lineBreak(index)}
      {this.verseNumber(item, index)}
      {this.mappedContents(item, index)}
    </React.Fragment>
  )

  indentedGroup = (item, index) => (
    <React.Fragment key={`indent-${index}`}>
      {this.lineBreak(index)}
      <Text style={styles.page__phrase}>{'\t\t\t'}</Text>
      {this.verseNumber(item, index)}
      {this.mappedContents(item, index)}
    </React.Fragment>
  )

  mappedContents = (item, index, multiplier = 100) =>
    item.contents.map((content, innerIndex) =>
      this.renderItem(content, index + innerIndex * multiplier)
    )

  verseNumber = (item, index) => {
    if (!('numbering' in item)) return
    const verseNum = item?.numbering?.normalizedVerseIsStarting
    if (verseNum === this.targetVerseNum) {
      return (
        <React.Fragment key={`verse-search-${index}`}>
          <View
            ref={ref => (this.targetVerseRef = ref)}
            style={styles.page__verseNumberMarkerForSearch}
            key={`verse-marker-${index}`}
          />
          {this.verseNumberText(verseNum, index)}
        </React.Fragment>
      )
    }
    return this.verseNumberText(verseNum, index)
  }

  verseNumberText = (verseNum, index) => (
    <Text style={styles.page__verseNum} key={`verse-num-${verseNum}-${index}`}>
      {`${verseNum} `}
    </Text>
  )

  lineBreak = index => (
    <Text key={`line-break-${index}`} style={styles.page__break}>
      {'\n'}
    </Text>
  )

  onWordPress = strongsNumbers => {
    this.setState({ ...this.state, strongsNumbers, popoverIsVisible: true })
  }

  onRequestClose = () => {
    this.setState({ ...this.state, popoverIsVisible: false })
  }

  keyExtractor = (item: any, index: number): string => {
    return item?.id
  }

  onRefresh = async () => {
    if (bibleStore.previousRange === undefined) {
      this.setState({ ...this.state, refreshing: false })
      return
    }
    this.setState({ ...this.state, refreshing: true })
    const visibleChapterNum = bibleStore.previousRange.versionChapterNum
    await bibleStore.updateCurrentBibleReference(bibleStore.previousRange)
    this.setState({
      ...this.state,
      refreshing: false,
      visibleChapterNum,
    })
  }

  onEndReached = async () => {
    if (bibleStore.nextRange === undefined) {
      this.setState({ ...this.state, loadingMoreOnBottom: false })
      return
    }
    this.setState({ ...this.state, loadingMoreOnBottom: true })
    await bibleStore.appendNextChapterToBottom(bibleStore.nextRange)
    this.setState({ ...this.state, loadingMoreOnBottom: false })
  }

  onVisibleIndicesChanged = async (all: number[]) => {
    const visibleChapterNum = bibleStore.dataProvider.getDataForIndex(all[0])
      ?.versionChapterNum
    console.log('onVisibleIndicesChanged: ', visibleChapterNum)
    if (this.state.visibleChapterNum !== visibleChapterNum) {
      this.setState({ ...this.state, visibleChapterNum })
    }
  }

  renderFooter = () =>
    this.state.loadingMoreOnBottom ? (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          height: 100,
        }}
      >
        <ActivityIndicator animating={true} color={Color.TYNDALE_BLUE} />
      </View>
    ) : null

  render() {
    return (
      <View style={styles.page}>
        <NavigationHeader chapterNum={this.state.visibleChapterNum} />
        <Popover
          isVisible={this.state.popoverIsVisible}
          fromView={null}
          onRequestClose={this.onRequestClose}
          popoverStyle={styles.page__popover}
        >
          <StrongsPopover strongs={this.state.strongsNumbers} />
        </Popover>
        {bibleStore.dataProvider.getSize() ? (
          <RecyclerListView
            scrollViewProps={{
              ref: ref => {
                this.listRef = ref
              },
              refreshControl: (
                <RefreshControl
                  refreshing={this.state.refreshing}
                  onRefresh={this.onRefresh}
                />
              ),
              showsVerticalScrollIndicator: false,
            }}
            forceNonDeterministicRendering
            style={{ flex: 1 }}
            contentContainerStyle={styles.page__container}
            onVisibleIndicesChanged={this.onVisibleIndicesChanged}
            onEndReached={this.onEndReached}
            onEndReachedThreshold={1000}
            layoutProvider={this.state.layoutProvider}
            dataProvider={bibleStore.dataProvider}
            renderFooter={this.renderFooter}
            rowRenderer={(type, data) => (
              <Text style={styles.page__section} selectable>
                {this.bibleSection(data.section, 0)}
              </Text>
            )}
          />
        ) : null}
        <QuickSettings />
      </View>
    )
  }
}

const LINE_HEIGHT = 27
const DEVICE_WIDTH = Dimensions.get('window').width

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  page__container: {
    paddingTop: Margin.MEDIUM,
  },
  page__section: {
    fontSize: FontSize.SMALL,
    paddingLeft: Margin.LARGE,
    paddingRight: Margin.LARGE,
    paddingBottom: Margin.SMALL,
  },
  page__section__title: {
    fontFamily: FontFamily.OPEN_SANS_SEMIBOLD,
    fontSize: FontSize.EXTRA_SMALL,
    lineHeight: LINE_HEIGHT,
  },
  page__break: {
    fontFamily: FontFamily.CARDO,
    fontSize: FontSize.SMALL,
    lineHeight: LINE_HEIGHT,
  },
  page__phrase: {
    fontFamily: FontFamily.CARDO,
    fontSize: FontSize.SMALL,
    lineHeight: LINE_HEIGHT,
  },
  page__strongs: {
    fontFamily: FontFamily.CARDO,
    fontSize: FontSize.SMALL,
    color: Color.TYNDALE_BLUE,
    lineHeight: LINE_HEIGHT,
  },
  page__verseNumberMarkerForSearch: {
    height: 10,
    width: 0,
  },
  page__verseNum: {
    fontFamily: FontFamily.OPEN_SANS_SEMIBOLD,
    fontSize: FontSize.SMALL,
    lineHeight: LINE_HEIGHT,
  },
  page__popover: {
    overflow: 'hidden',
    width: DEVICE_WIDTH - 20,
  },
  page__footer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 100,
  },
})
