import os
import json
import numpy as np
import pandas as pd
from sklearn.preprocessing import LabelEncoder
import pickle

project_dir = r'C:\Users\김동하\OneDrive\바탕 화면\AirCraft'
data_index_path = os.path.join(project_dir, 'public', 'data', 'design-index.json')
output_csv = os.path.join(project_dir, 'dataset_510k.csv')
preprocessor_path = os.path.join(project_dir, 'dl_preprocessor.pkl')

# ⚠️ 여기에 실제 AircraftVerse 원본 데이터 폴더가 있는 상위 경로를 적어야 합니다.
# (예: project_dir 안에 있다면 그대로 사용)
aircraftverse_root = project_dir 

def build_dataset():
    print("1. design-index.json 로드 중...")
    with open(data_index_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    designs = data['designs']
    # 유효한 설계만 필터링
    valid_designs = [d for d in designs if d.get('feasible') and d.get('powerAt0', 0) > 0]
    print(f"유효한 설계 개수: {len(valid_designs)}개")

    # 범주형 변수 인코딩 준비
    cat_cols = ['hub', 'primaryMotor', 'primaryPropeller', 'primaryBattery']
    encoders = {col: LabelEncoder() for col in cat_cols}
    
    # 미리 전체 데이터로 인코딩 피팅
    df_valid = pd.DataFrame(valid_designs)
    for col in cat_cols:
        df_valid[f'{col}_enc'] = encoders[col].fit_transform(df_valid[col].fillna('Unknown'))

    # 전처리기 저장 (나중에 추론할 때 사용)
    with open(preprocessor_path, 'wb') as f:
        pickle.dump({'encoders': encoders}, f)
    
    # 입력 파라미터 20개 추출
    features_base = [
        'numPropellers', 'numWings', 'armLength', 'meanArmLength', 'maxArmLength',
        'fuselageLength', 'fuselageHorizontalDiameter', 'fuselageVerticalDiameter',
        'totalWingSpan', 'meanWingChord', 'parameterCount'
    ]
    
    # 데이터 생성 루프
    all_rows = []
    missing_trims = 0
    
    print("2. trims.npy 읽고 데이터셋 결합 중... (시간이 조금 걸릴 수 있습니다)")
    for idx, row in df_valid.iterrows():
        design_id = row['id']
        # trims.npy 경로 찾기 (AircraftVerse_1, 2, 3 중 어디 있는지 확인)
        trim_path = None
        for source_name in ['AircraftVerse_1', 'AircraftVerse_2', 'AircraftVerse_3']:
            temp_path = os.path.join(aircraftverse_root, 'AircraftVerse', source_name, f'design_{design_id}', 'trims.npy')
            if os.path.exists(temp_path):
                trim_path = temp_path
                break
                
        if trim_path is None:
            missing_trims += 1
            continue
            
        # trims.npy 로드 (shape: [51, 12])
        try:
            trims = np.load(trim_path)
        except:
            missing_trims += 1
            continue
            
        # 공통 설계 파라미터 (15개)
        geom_inputs = [row.get(f, 0) for f in features_base] + [row[f'{c}_enc'] for c in cat_cols]
        
        # trims.npy에서 0m/s와 20m/s의 모든 물리량 힌트 직접 추출
        # speed: 0, distance: 1, flightTime: 2, pitch: 3, maxUc: 4, thrust: 5, lift: 6, drag: 7, current: 8, power: 9
        trim20 = trims[20]
        trim0 = trims[0]
        
        physics_hints = [
            trim20[7], trim20[6], trim20[5], trim20[3], trim20[9], trim20[8], # 20m/s: drag, lift, thrust, pitch, power, current
            trim0[5], trim0[9], trim0[8] # 0m/s: thrust, power, current
        ]
        
        base_inputs = geom_inputs + physics_hints
        
        # 51개 속도 구간(0~50)에 대해 행(row) 생성
        for speed in range(51):
            # speed: 0, distance: 1, flightTime: 2, pitch: 3, maxUc: 4, thrust: 5, lift: 6, drag: 7, current: 8, power: 9
            trim_data = trims[speed]
            
            # 우리가 예측하고 싶은 타겟 8개
            outputs = [
                trim_data[7], # drag
                trim_data[6], # lift
                trim_data[5], # thrust
                trim_data[3], # pitch
                trim_data[9], # power
                trim_data[8], # current
                trim_data[2], # flightTime
                trim_data[1]  # distance
            ]
            
            # 최종 한 줄: [id, speed] + [파라미터 20개] + [물리량 8개]
            final_row = [design_id, speed] + base_inputs + outputs
            all_rows.append(final_row)
            
        if (idx + 1) % 1000 == 0:
            print(f"  진행 상황: {idx + 1} / {len(df_valid)}")

    print(f"3. CSV 저장 중... (총 {len(all_rows)} 줄, 누락된 파일 {missing_trims}개)")
    
    columns = (
        ['design_id', 'speed'] +
        features_base +
        ['hub_enc', 'primaryMotor_enc', 'primaryPropeller_enc', 'primaryBattery_enc'] +
        ['dragAt20', 'liftAt20', 'thrustAt20', 'pitchAt20', 'powerAt20', 'currentAt20', 'thrustAt0', 'powerAt0', 'currentAt0'] +
        ['target_drag', 'target_lift', 'target_thrust', 'target_pitch', 'target_power', 'target_current', 'target_flightTime', 'target_distance']
    )
    
    df_out = pd.DataFrame(all_rows, columns=columns)
    df_out.to_csv(output_csv, index=False)
    print(f"✅ 완료! 파일 크기: {os.path.getsize(output_csv) / (1024*1024):.1f} MB")
    print(f"✅ 저장 위치: {output_csv}")

if __name__ == '__main__':
    build_dataset()

