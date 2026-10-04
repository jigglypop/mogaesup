//! OX 퀴즈's statements: timeless, settled general knowledge (basic science, animals, the human body, geography, the
//! Korean language and culture, arithmetic), each true (O) or false (X) beyond argument. Nothing about current events,
//! records that move, rankings, prices or living people. About as many are true as false.

/// A statement shown to everyone, and whether it is true (the O zone) or false (the X zone).
pub(super) struct Question {
    pub(super) statement: &'static str,
    pub(super) answer: bool,
}

/// A true statement.
const fn o(statement: &'static str) -> Question {
    Question { statement, answer: true }
}

/// A false statement.
const fn x(statement: &'static str) -> Question {
    Question { statement, answer: false }
}

pub(super) const BANK: &[Question] = &[
    // Arithmetic and shapes
    o("삼각형의 세 각을 모두 더하면 180도예요."),
    x("가장 작은 소수는 1이에요."),
    o("0은 짝수예요."),
    o("정사각형은 직사각형의 한 종류예요."),
    x("1킬로그램은 100그램이에요."),
    o("원의 지름은 반지름의 두 배예요."),
    x("홀수는 모두 소수예요."),
    x("육각형의 변은 8개예요."),
    o("하루는 1440분이에요."),
    o("1부터 10까지 모두 더하면 55예요."),
    x("음수에 음수를 곱하면 음수가 돼요."),
    o("어떤 수에 0을 곱하면 항상 0이에요."),
    x("정육면체의 면은 8개예요."),
    o("1시간은 3600초예요."),
    x("한 다스는 10개예요."),
    x("원주율은 정확히 3.14예요."),
    o("2의 10제곱은 1024예요."),
    o("평행사변형의 마주 보는 변은 길이가 같아요."),
    x("100은 소수예요."),
    x("1미터는 1000센티미터예요."),
    o("직각은 90도예요."),
    // Science
    o("물은 얼면 부피가 커져요."),
    x("얼음은 물에 가라앉아요."),
    x("소리는 진공에서도 전달돼요."),
    x("소리는 빛보다 빨라요."),
    x("달은 스스로 빛을 내요."),
    o("태양은 스스로 빛을 내는 별이에요."),
    o("태양계에서 가장 큰 행성은 목성이에요."),
    x("태양에서 가장 가까운 행성은 금성이에요."),
    o("식물은 광합성을 하면서 산소를 내보내요."),
    x("식물은 주로 뿌리에서 광합성을 해요."),
    x("자석의 같은 극끼리는 서로 끌어당겨요."),
    x("공기 중에 가장 많은 기체는 산소예요."),
    o("물 분자는 수소와 산소로 이루어져 있어요."),
    o("다이아몬드는 탄소로 이루어져 있어요."),
    o("토성에는 고리가 있어요."),
    x("고무는 전기가 잘 통해요."),
    o("소금물은 맹물보다 끓는점이 높아요."),
    o("같은 물체라도 달에서는 지구에서보다 무게가 가벼워요."),
    x("금은 자석에 붙어요."),
    x("지구는 달 주위를 돌아요."),
    x("달은 지구보다 커요."),
    o("공기가 없으면 깃털과 쇠공은 같은 빠르기로 떨어져요."),
    x("해는 서쪽에서 떠요."),
    o("북반구가 여름일 때 남반구는 겨울이에요."),
    x("지구는 1년에 한 바퀴 자전해요."),
    o("지구가 태양 주위를 한 바퀴 도는 데 약 1년이 걸려요."),
    // Animals
    o("고래는 포유류예요."),
    x("박쥐는 새예요."),
    o("펭귄은 날지 못하는 새예요."),
    x("거미의 다리는 6개예요."),
    o("곤충의 다리는 6개예요."),
    o("개구리는 양서류예요."),
    x("상어는 포유류예요."),
    o("오리너구리는 알을 낳는 포유류예요."),
    x("문어의 다리는 10개예요."),
    o("기린의 목뼈 개수는 사람과 같아요."),
    x("낙타의 혹에는 물이 들어 있어요."),
    o("나비는 애벌레 시기를 거쳐요."),
    x("달팽이는 곤충이에요."),
    x("돌고래는 아가미로 숨을 쉬어요."),
    x("타조는 하늘을 날 수 있어요."),
    x("거북은 양서류예요."),
    o("사람의 피를 빠는 모기는 암컷이에요."),
    x("지렁이는 뼈가 있어요."),
    o("판다는 주로 대나무를 먹어요."),
    x("고래상어는 고래의 한 종류예요."),
    o("해마는 물고기예요."),
    o("코끼리는 육지에 사는 동물 중 가장 커요."),
    // The human body
    o("어른의 뼈는 약 206개예요."),
    o("적혈구는 몸속에서 산소를 날라요."),
    o("사람 몸에서 가장 큰 기관은 피부예요."),
    x("사람의 이는 평생 한 번만 나요."),
    o("갓난아기는 어른보다 뼈의 개수가 많아요."),
    o("심장은 근육으로 이루어져 있어요."),
    x("사람의 폐는 하나예요."),
    o("사람의 정상 체온은 약 36.5도예요."),
    o("사람 몸에서 가장 많은 성분은 물이에요."),
    x("사람의 심장은 배 속에 있어요."),
    x("손톱은 한 번 자르면 다시 자라지 않아요."),
    x("사람 몸에서 가장 긴 뼈는 갈비뼈예요."),
    x("어른의 이는 보통 20개예요."),
    x("피는 심장에서만 만들어져요."),
    // The world
    o("지구에서 가장 넓은 바다는 태평양이에요."),
    o("사하라 사막은 아프리카에 있어요."),
    o("영국의 수도는 런던이에요."),
    o("브라질은 남아메리카에 있어요."),
    o("알프스산맥은 유럽에 있어요."),
    o("지중해는 유럽과 아프리카 사이에 있어요."),
    o("적도는 지구를 남반구와 북반구로 나눠요."),
    x("에베레스트산은 남아메리카에 있어요."),
    x("북극은 땅으로 된 대륙이에요."),
    x("지구 표면은 육지가 바다보다 넓어요."),
    x("일본은 우리나라의 서쪽에 있어요."),
    x("오스트레일리아의 수도는 시드니예요."),
    x("캐나다의 수도는 토론토예요."),
    x("아마존강은 아시아에 있어요."),
    // Korea
    o("한라산은 제주도에 있어요."),
    o("제주도는 우리나라에서 가장 큰 섬이에요."),
    o("한강은 서울을 가로질러 흘러요."),
    o("한반도는 삼면이 바다로 둘러싸여 있어요."),
    o("제주도는 화산 활동으로 생긴 섬이에요."),
    x("대한민국의 수도는 부산이에요."),
    x("남한에서 가장 높은 산은 지리산이에요."),
    x("서울은 한반도의 동쪽 끝에 있어요."),
    x("경주는 백제의 수도였어요."),
    // Korean language and culture
    o("한글은 세종대왕 때 만들어졌어요."),
    o("한글날은 10월 9일이에요."),
    o("한글 자음 'ㄱ'의 이름은 '기역'이에요."),
    x("'ㅏ'는 자음이에요."),
    o("추석은 음력 8월 15일이에요."),
    x("설날은 음력 5월 5일이에요."),
    x("정월 대보름은 음력 8월 15일이에요."),
    o("김치는 발효 음식이에요."),
    o("태극기에는 괘가 4개 있어요."),
    x("태극기의 바탕은 검은색이에요."),
    o("윷놀이에서 '모'가 나오면 다섯 칸을 가요."),
    x("윷놀이에서 '도'가 나오면 두 칸을 가요."),
    o("가야금은 줄을 뜯어 소리를 내는 악기예요."),
    x("장구는 입으로 불어 소리를 내는 악기예요."),
    o("사물놀이는 네 가지 악기로 연주해요."),
    o("송편은 주로 추석에 빚어 먹어요."),
    x("떡국은 주로 추석에 먹는 음식이에요."),
    o("동지에는 팥죽을 먹는 풍습이 있어요."),
    o("판소리는 소리꾼과 고수가 함께해요."),
    x("세종대왕은 고려의 왕이었어요."),
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn the_bank_holds_at_least_eighty_short_different_statements() {
        assert!(BANK.len() >= 80, "{} statements", BANK.len());
        let mut seen = HashSet::new();
        for question in BANK {
            let statement = question.statement;
            assert!(statement.chars().count() <= 60, "too long: {statement}");
            assert_eq!(statement.trim(), statement, "stray spaces: {statement:?}");
            assert!(statement.ends_with("요."), "one sentence in the -요 register: {statement}");
            assert!(!statement.contains("  ") && !statement.contains('\n'), "{statement:?}");
            // The same sentence spaced or punctuated another way is still the same.
            let bare: String = statement.chars().filter(|c| c.is_alphanumeric()).collect();
            assert!(seen.insert(bare), "twice: {statement}");
        }
    }

    #[test]
    fn about_half_the_statements_are_true() {
        let true_ones = BANK.iter().filter(|question| question.answer).count();
        let share = true_ones as f64 / BANK.len() as f64;
        assert!((0.45..=0.55).contains(&share), "{true_ones} of {} are O", BANK.len());
    }
}
